import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CarteiraService } from '../src/carteira/carteira.service';
import { LotesInscricaoService } from '../src/ligas-competicoes/lotes-inscricao.service';
import { InscricoesCompeticaoService } from '../src/ligas-competicoes/inscricoes-competicao.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Somente MySQL dedicado de teste com 0018 aplicada; nunca usa DATABASE_URL nem executa migrations.
const databaseUrl = process.env.CARTEIRA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('Inscricoes em lote - atomicidade e concorrencia MySQL', () => {
  const prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  const carteiras = new CarteiraService(prisma as PrismaService);
  const service = new LotesInscricaoService(prisma as PrismaService, carteiras);
  let usuarioId: number;
  let competicoes: number[];
  let vinculo: { id: number; ligaId: number; modalidadeId: number };
  const dto = { timesCartolaIds: [123, 456], valorUnitarioEsperado: '10.00' };
  beforeAll(() => prisma.$connect());
  beforeEach(async () => {
    await prisma.$transaction(async tx => {
      const token = randomUUID();
      usuarioId = (await tx.usuario.create({ data: { email: `lote-compra-${token}@example.invalid` } })).idUsuario;
      vinculo = await tx.ligaModalidade.create({ data: {
        liga: { create: { nome: 'Compra lote', slug: `compra-${token}`, tipo: 'OFICIAL' } },
        modalidade: { create: { nome: 'Compra lote', codigo: `compra-${token}` } },
      } });
      competicoes = [];
      for (let i = 0; i < 2; i++) {
        competicoes.push((await tx.competicaoLiga.create({ data: { ligaModalidadeId: vinculo.id,
          nome: 'Compra lote', slug: `compra-${token}-${i}`, tipoAcesso: 'PAGO', valorInscricao: '10',
          status: 'INSCRICOES_ABERTAS', visivelApp: true, limiteParticipantes: 100, limiteTimesUsuario: 50,
        } })).id);
      }
      for (const timeId of dto.timesCartolaIds) await tx.timeUsuario.create({ data: { usuarioId, timeId, nome: `Time ${timeId}` } });
      await carteiras.creditarEmTransacao(tx, { usuarioId, valor: '30', origem: 'AJUSTE' });
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.$transaction(async tx => {
      // Apenas registros criados por esta fixture, em ordem de FKs.
      await tx.inscricaoTimeCompeticao.deleteMany({ where: { usuarioId } });
      await tx.loteInscricao.deleteMany({ where: { usuarioId } });
      await tx.movimentacaoCarteira.deleteMany({ where: { carteira: { usuarioId } } });
      await tx.carteira.deleteMany({ where: { usuarioId } });
      await tx.timeUsuario.deleteMany({ where: { usuarioId } });
      await tx.usuario.delete({ where: { idUsuario: usuarioId } });
      await tx.competicaoLiga.deleteMany({ where: { ligaModalidadeId: vinculo.id } });
      await tx.ligaModalidade.delete({ where: { id: vinculo.id } });
      await tx.liga.delete({ where: { id: vinculo.ligaId } });
      await tx.modalidadeCompeticao.delete({ where: { id: vinculo.modalidadeId } });
    });
  });
  afterAll(() => prisma.$disconnect());
  const comprar = (key: string, id = competicoes[0]) => service.criar(id, usuarioId, dto, key);
  const saldo = async () => (await prisma.carteira.findUniqueOrThrow({ where: { usuarioId } })).saldoDisponivel.toFixed(2);
  const debitos = () => prisma.movimentacaoCarteira.count({ where: { carteira: { usuarioId }, origem: 'INSCRICAO', tipo: 'DEBITO' } });
  async function semCompra(esperado = '30.00') {
    expect(await saldo()).toBe(esperado);
    expect(await debitos()).toBe(0);
    expect(await prisma.loteInscricao.count({ where: { usuarioId } })).toBe(0);
    expect(await prisma.inscricaoTimeCompeticao.count({ where: { usuarioId } })).toBe(0);
  }

  it('confirma todos os vinculos com um unico debito e replay apos commit', async () => {
    const key = randomUUID(); const resposta = await comprar(key);
    expect(resposta).toMatchObject({ quantidade: 2, valorTotal: '20.00', saldoDisponivelAposOperacao: '10.00' });
    expect(await debitos()).toBe(1);
    expect(await prisma.inscricaoTimeCompeticao.count({ where: { loteInscricaoId: resposta.loteId } })).toBe(2);
    await prisma.competicaoLiga.update({ where: { id: competicoes[0] }, data: { status: 'ENCERRADA' } });
    expect(await comprar(key)).toEqual(resposta);
    expect(await saldo()).toBe('10.00'); expect(await debitos()).toBe(1);
  });

  it('duas chamadas simultaneas com mesma chave retornam mesmo lote e debitam uma vez', async () => {
    const key = randomUUID(); const [a, b] = await Promise.all([comprar(key), comprar(key)]);
    expect(a).toEqual(b); expect(await debitos()).toBe(1); expect(await saldo()).toBe('10.00');
    expect(await prisma.loteInscricao.count({ where: { usuarioId } })).toBe(1);
  });

  it('mesma chave concorrente em competicoes diferentes gera um sucesso e um conflito de conteudo', async () => {
    const key = randomUUID();
    const resultados = await Promise.allSettled([comprar(key), comprar(key, competicoes[1])]);
    expect(resultados.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((resultados.find(item => item.status === 'rejected') as PromiseRejectedResult).reason.response.code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
    expect(await debitos()).toBe(1); expect(await saldo()).toBe('10.00');
  });

  it('compras simultaneas em competicoes diferentes nao consomem o mesmo saldo', async () => {
    const resultados = await Promise.allSettled([comprar(randomUUID()), comprar(randomUUID(), competicoes[1])]);
    expect(resultados.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((resultados.find(item => item.status === 'rejected') as PromiseRejectedResult).reason.response.code).toBe('SALDO_INSUFICIENTE');
    expect(await debitos()).toBe(1); expect(await saldo()).toBe('10.00');
    expect(await prisma.inscricaoTimeCompeticao.count({ where: { usuarioId } })).toBe(2);
    expect(await prisma.loteInscricao.count({ where: { usuarioId } })).toBe(1);
  });

  it('saldo insuficiente reverte inscricoes/lote e permite retry da mesma chave apos credito', async () => {
    const key = randomUUID(); await carteiras.debitar({ usuarioId, valor: '25', origem: 'AJUSTE' });
    await expect(comprar(key)).rejects.toMatchObject({ response: { code: 'SALDO_INSUFICIENTE', saldoDisponivel: '5.00', valorFaltante: '15.00' } });
    await semCompra('5.00');
    await carteiras.creditar({ usuarioId, valor: '15', origem: 'AJUSTE' });
    await expect(comprar(key)).resolves.toMatchObject({ saldoDisponivelAposOperacao: '0.00' });
  });

  it.each(['apos_inscricoes', 'apos_debito'] as const)('rollback real %s permite repetir a chave', async etapa => {
    const key = randomUUID();
    if (etapa === 'apos_inscricoes') {
      jest.spyOn(carteiras, 'obterOuCriarEmTransacao').mockRejectedValueOnce(new Error('Falha apos inscricoes'));
    } else {
      const debitar = carteiras.debitarEmTransacao.bind(carteiras);
      jest.spyOn(carteiras, 'debitarEmTransacao').mockImplementationOnce(async (tx, input) => {
        await debitar(tx, input);
        expect((await tx.carteira.findUniqueOrThrow({ where: { usuarioId } })).saldoDisponivel.toFixed(2)).toBe('10.00');
        throw new Error('Falha apos debito');
      });
    }
    await expect(comprar(key)).rejects.toThrow('Falha apos'); await semCompra();
    await expect(comprar(key)).resolves.toMatchObject({ quantidade: 2 });
  });

  it('preco divergente nao persiste efeitos e nao consome chave', async () => {
    const key = randomUUID();
    await expect(service.criar(competicoes[0], usuarioId, { ...dto, valorUnitarioEsperado: '9.00' }, key))
      .rejects.toMatchObject({ response: { code: 'PRECO_INSCRICAO_ALTERADO' } });
    await semCompra(); await expect(comprar(key)).resolves.toMatchObject({ quantidade: 2 });
  });

  it('lote com time ja inscrito nao cria o subconjunto restante', async () => {
    await service.criar(competicoes[0], usuarioId, { timesCartolaIds: [123] }, randomUUID());
    await expect(comprar(randomUUID())).rejects.toMatchObject({ response: { code: 'TIME_JA_INSCRITO' } });
    expect(await debitos()).toBe(1); expect(await saldo()).toBe('20.00');
    expect(await prisma.inscricaoTimeCompeticao.count({ where: { usuarioId } })).toBe(1);
  });

  it('FREE novo e legado permanecem sem debitos e historico legado sem lote', async () => {
    await prisma.competicaoLiga.update({ where: { id: competicoes[0] }, data: { tipoAcesso: 'FREE', valorInscricao: '0' } });
    const novo = await service.criar(competicoes[0], usuarioId, { timesCartolaIds: [123] }, randomUUID());
    expect(novo).toMatchObject({ valorTotal: '0.00', movimentacaoDebitoId: null });
    const legado = new InscricoesCompeticaoService(prisma as PrismaService);
    await legado.criar(competicoes[0], usuarioId, [456]);
    expect(await prisma.inscricaoTimeCompeticao.findUniqueOrThrow({
      where: { competicaoLigaId_timeIdCartola: { competicaoLigaId: competicoes[0], timeIdCartola: 456 } },
    })).toMatchObject({ loteInscricaoId: null });
    expect(await debitos()).toBe(0); expect(await saldo()).toBe('30.00');
  });

  it('ultima vaga concorrente aceita somente um time', async () => {
    await prisma.competicaoLiga.update({ where: { id: competicoes[0] }, data: { limiteParticipantes: 1 } });
    const resultados = await Promise.allSettled([123, 456].map(timeId =>
      service.criar(competicoes[0], usuarioId, { timesCartolaIds: [timeId] }, randomUUID())));
    expect(resultados.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((resultados.find(item => item.status === 'rejected') as PromiseRejectedResult).reason.response.code).toBe('LIMITE_PARTICIPANTES_ATINGIDO');
    expect(await debitos()).toBe(1); expect(await saldo()).toBe('20.00');
  });
});
