import { ConflictException, NotFoundException } from '@nestjs/common';
import { Desafio, DesafioInscricao, DesafioPalpite, DesafioPartida, Prisma } from '@prisma/client';
import { DesafiosService } from '../src/desafios/desafios.service';
import { ListarDesafiosQueryDto } from '../src/desafios/dto/desafios.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const agora = new Date('2030-10-03T12:00:00Z');
const desafio = (id = 7, change: Partial<Desafio> = {}): Desafio => ({
  id, nome: 'Desafio publico', descricao: 'Jogos do dia', tipoAcesso: 'FREE', valorInscricao: new Prisma.Decimal(0),
  status: 'ABERTO', inicioInscricao: new Date('2030-10-01T00:00:00Z'), fimInscricao: new Date('2030-10-03T10:00:00Z'),
  dataInicio: new Date('2030-10-03T11:00:00Z'), dataFim: new Date('2030-10-04T23:00:00Z'),
  limiteParticipantes: 1, limiteInscricoesPorUsuario: 1, criadoPorId: 99, publicadoEm: new Date('2030-09-30T00:00:00Z'),
  criadoEm: new Date(), atualizadoEm: new Date(), ...change,
});
const partida = (id = 1, change: Partial<DesafioPartida> = {}): DesafioPartida => ({
  id, desafioId: 7, fixtureIdApiFootball: 100 + id, leagueIdApiFootball: 2013, nomeCompeticao: 'Serie A',
  mandanteIdApiFootball: 900001, nomeMandante: 'Mandante', logoMandanteUrl: 'https://example.com/home.png',
  visitanteIdApiFootball: 900002, nomeVisitante: 'Visitante', logoVisitanteUrl: null,
  dataInicio: new Date('2030-10-03T16:00:00Z'), status: 'AGENDADA', resultado: null,
  golsMandante: null, golsVisitante: null, ordem: id, criadoEm: new Date(), atualizadoEm: new Date(), ...change,
});
const palpite = (usuarioId = 42, partidaId = 1, change: Partial<DesafioPalpite> = {}): DesafioPalpite => ({
  id: usuarioId * 10 + partidaId, inscricaoId: usuarioId, desafioId: 7, desafioPartidaId: partidaId, usuarioId, palpite: 'CASA',
  pontos: null, apurado: false, criadoEm: new Date(), atualizadoEm: new Date(), ...change,
});

type FiltroPublico = { id?: number; status: { in: string[] }; publicadoEm: { lte: Date };
  inicioInscricao: { lte: Date }; tipoAcesso?: string };

const inscricao = (usuarioId = 42): DesafioInscricao => ({ id: usuarioId, desafioId: 7, usuarioId,
  sequencia: 1, chaveIdempotencia: null, status: 'RASCUNHO', valorInscricao: new Prisma.Decimal(0),
  movimentacaoDebitoId: null, dataInscricao: agora, criadoEm: agora, atualizadoEm: agora });

function setup() {
  const state = { desafios: [desafio()], partidas: [partida()], palpites: [] as DesafioPalpite[], inscricoes: [] as DesafioInscricao[] };
  const filtrar = (where: FiltroPublico) => state.desafios.filter(d => (where.id === undefined || d.id === where.id)
    && where.status.in.includes(d.status) && d.publicadoEm !== null && d.publicadoEm <= where.publicadoEm.lte
    && d.inicioInscricao <= where.inicioInscricao.lte
    && (where.tipoAcesso === undefined || d.tipoAcesso === where.tipoAcesso));
  const proibido = jest.fn(() => { throw new Error('Inscricao/financeiro nao pertencem a esta etapa'); });
  const foraDoEscopo = { findUnique: proibido, findFirst: proibido, findMany: proibido, count: proibido,
    create: proibido, update: proibido, upsert: proibido };
  const tx = {
    desafio: {
      count: jest.fn(async ({ where }: { where: FiltroPublico }) => filtrar(where).length),
      findMany: jest.fn(async ({ where, skip, take }: { where: FiltroPublico; skip: number; take: number }) =>
        filtrar(where).sort((a, b) => +a.dataInicio - +b.dataInicio || a.id - b.id).slice(skip, skip + take)),
      findFirst: jest.fn(async ({ where }: { where: FiltroPublico }) => {
        const row = filtrar(where)[0];
        return row ? { ...row, partidas: state.partidas.filter(p => p.desafioId === row.id)
          .sort((a, b) => a.ordem - b.ordem || a.id - b.id) } : null;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: number } }) => state.desafios.find(d => d.id === where.id) ?? null),
    },
    desafioPartida: { findFirst: jest.fn(async ({ where }: { where: { id: number; desafioId: number } }) =>
      state.partidas.find(p => p.id === where.id && p.desafioId === where.desafioId) ?? null) },
    desafioPalpite: {
      findMany: jest.fn(async ({ where }: { where: { desafioId: number; usuarioId: number } }) =>
        state.palpites.filter(p => p.desafioId === where.desafioId && p.usuarioId === where.usuarioId)),
      upsert: jest.fn(async ({ where, create, update }: {
        where: { inscricaoId_desafioPartidaId: { desafioPartidaId: number; inscricaoId: number } };
        create: Pick<DesafioPalpite, 'desafioId' | 'desafioPartidaId' | 'usuarioId' | 'palpite' | 'inscricaoId'>;
        update: Pick<DesafioPalpite, 'palpite'>;
      }) => {
        const key = where.inscricaoId_desafioPartidaId;
        const row = state.palpites.find(p => p.desafioPartidaId === key.desafioPartidaId && p.inscricaoId === key.inscricaoId);
        if (row) { row.palpite = update.palpite; return row; }
        const novo = palpite(create.usuarioId, create.desafioPartidaId, create);
        state.palpites.push(novo); return novo;
      }),
    },
    desafioInscricao: {
      findUnique: jest.fn(async ({ where }: { where: { desafioId_usuarioId_sequencia: {
        desafioId: number; usuarioId: number; sequencia: number } } }) => {
        const key = where.desafioId_usuarioId_sequencia;
        return state.inscricoes.find(i => i.desafioId === key.desafioId && i.usuarioId === key.usuarioId && i.sequencia === key.sequencia) ?? null;
      }),
      findMany: jest.fn(async ({ where }: { where: { desafioId: number; usuarioId: number } }) =>
        state.inscricoes.filter(i => i.desafioId === where.desafioId && i.usuarioId === where.usuarioId)),
      findFirst: jest.fn(async ({ where }: { where: { id: number; desafioId: number; usuarioId: number } }) =>
        state.inscricoes.find(i => i.id === where.id && i.desafioId === where.desafioId && i.usuarioId === where.usuarioId) ?? null),
      create: jest.fn(async ({ data }: { data: Partial<DesafioInscricao> & { usuarioId: number } }) => {
        const row = { ...inscricao(data.usuarioId), ...data }; state.inscricoes.push(row); return row;
      }),
    },
    carteira: foraDoEscopo, movimentacaoCarteira: foraDoEscopo,
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: number[]) => {
      const existe = sql.join(' ').includes('DESAFIO_PARTIDA')
        ? state.partidas.some(p => p.id === values[0] && p.desafioId === values[1])
        : state.desafios.some(d => d.id === values[0]);
      return existe ? [{ ID: BigInt(values[0]) }] : [];
    }),
  };
  let queue = Promise.resolve();
  const prisma = { ...tx, $transaction: jest.fn(async (acao: ((client: typeof tx) => Promise<unknown>) | Promise<unknown>[]) => {
    if (Array.isArray(acao)) return Promise.all(acao);
    const anterior = queue; let liberar!: () => void;
    queue = new Promise<void>(resolve => { liberar = resolve; });
    await anterior;
    const backup = state.palpites.map(p => ({ ...p }));
    const backupInscricoes = state.inscricoes.map(i => ({ ...i }));
    try { return await acao(tx); } catch (error) { state.palpites = backup; state.inscricoes = backupInscricoes; throw error; } finally { liberar(); }
  }) };
  return { state, tx, prisma, proibido, service: new DesafiosService(prisma as unknown as PrismaService) };
}

describe('Desafios publicos e meus palpites', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(agora); });
  afterEach(() => jest.useRealTimers());

  it('reutiliza nomes de Futebol por ID sem modificar snapshots e preserva desconhecidos', async () => {
    const f = setup();
    f.state.partidas = [partida(1, { mandanteIdApiFootball: 1783, nomeMandante: 'CR Flamengo',
      visitanteIdApiFootball: 1903, nomeVisitante: 'Sport Lisboa e Benfica' }),
    partida(2, { mandanteIdApiFootball: 4294967295, nomeMandante: 'Clube desconhecido' })];
    const result = await f.service.buscar(7);
    expect(result.partidas[0]).toMatchObject({ nomeMandante: 'Flamengo', nomeVisitante: 'Benfica' });
    expect(result.partidas[1].nomeMandante).toBe('Clube desconhecido');
    expect(f.state.partidas[0]).toMatchObject({ nomeMandante: 'CR Flamengo', nomeVisitante: 'Sport Lisboa e Benfica' });
  });

  it('detalhe autenticado identifica cartelas e palpites independentes; publico omite dados pessoais', async () => {
    const f = setup(); f.state.desafios[0].limiteInscricoesPorUsuario = 3;
    f.state.inscricoes = [{ ...inscricao(), status: 'ATIVA' }, { ...inscricao(), id: 100, sequencia: 2, status: 'ATIVA' },
      { ...inscricao(), id: 101, sequencia: 3 }, { ...inscricao(43), status: 'ATIVA' }];
    f.state.palpites = [palpite(42, 1, { pontos: new Prisma.Decimal(1), apurado: true }),
      palpite(42, 1, { inscricaoId: 100, palpite: 'FORA', pontos: new Prisma.Decimal(0), apurado: true }), palpite(43)];
    const result = await f.service.buscar(7, 42);
    expect(result).toMatchObject({ limiteInscricoesPorUsuario: 3, quantidadeUtilizada: 2, inscrito: true });
    expect(result.minhasInscricoes?.map(i => [i.id, i.numero, i.nome, i.status, i.palpites[0].meuPalpite, i.palpites[0].pontos, i.palpites[0].apurado]))
      .toEqual([[42, 1, 'Palpite 1', 'ATIVA', 'CASA', 1, true], [100, 2, 'Palpite 2', 'ATIVA', 'FORA', 0, true],
        [101, 3, 'Palpite 3', 'RASCUNHO', null, null, false]]);
    expect(result.partidas[0]).toMatchObject({ meuPalpite: 'CASA', pontos: 1, apurado: true });
    const publico = await f.service.buscar(7);
    for (const campo of ['minhasInscricoes', 'quantidadeUtilizada', 'minhaInscricao', 'inscrito']) expect(publico).not.toHaveProperty(campo);
    for (const campo of ['meuPalpite', 'pontos', 'apurado']) expect(publico.partidas[0]).not.toHaveProperty(campo);
  });

  it('inscrito considera qualquer cartela ativa e sequencia nao depende da posicao no array', async () => {
    const f = setup();
    f.state.inscricoes = [{ ...inscricao(), id: 100, sequencia: 2, status: 'ATIVA' }];
    const result = await f.service.buscar(7, 42);
    expect(result).toMatchObject({ inscrito: true, quantidadeUtilizada: 1, minhaInscricao: null });
    expect(result.minhasInscricoes?.[0]).toMatchObject({ numero: 2, nome: 'Palpite 2' });
    expect(result.partidas[0].meuPalpite).toBeNull();
  });

  it.each(['AGENDADA', 'EM_ANDAMENTO', 'FINALIZADA', 'ANULADA'] as const)
  ('expoe placar persistido e preserva status %s sem derivar pelo horario', async status => {
    const f = setup();
    f.state.partidas = [partida(1, { status }), partida(2, { status, golsMandante: 2, golsVisitante: 0 })];
    const result = await f.service.buscar(7);
    expect(result.partidas[0]).toMatchObject({ status, statusInterno: status, golsMandante: null, golsVisitante: null });
    expect(result.partidas[1]).toMatchObject({ status, statusInterno: status, golsMandante: 2, golsVisitante: 0 });
  });

  it.each([
    { status: 'AGENDADA', palpite: 'CASA', pontos: null, apurado: false },
    { status: 'FINALIZADA', palpite: 'CASA', pontos: 1, apurado: true },
    { status: 'FINALIZADA', palpite: 'FORA', pontos: 0, apurado: true },
    { status: 'ANULADA', palpite: 'CASA', pontos: null, apurado: false },
  ] as const)('expoe a apuracao persistida do proprio palpite: %j', async caso => {
    const f = setup();
    f.state.partidas[0].status = caso.status;
    f.state.inscricoes = [inscricao()];
    f.state.palpites = [palpite(42, 1, { palpite: caso.palpite,
      pontos: caso.pontos === null ? null : new Prisma.Decimal(caso.pontos), apurado: caso.apurado }),
    palpite(43, 1, { pontos: new Prisma.Decimal(99), apurado: true })];
    expect((await f.service.buscar(7, 42)).partidas[0]).toMatchObject({
      meuPalpite: caso.palpite, pontos: caso.pontos, apurado: caso.apurado, statusInterno: caso.status,
    });
    expect((await f.service.buscar(7, 99)).partidas[0]).toMatchObject({ meuPalpite: null, pontos: null, apurado: false });
    f.tx.desafioPalpite.findMany.mockClear();
    const publico = (await f.service.buscar(7)).partidas[0];
    for (const campo of ['meuPalpite', 'pontos', 'apurado', 'usuarioId']) expect(publico).not.toHaveProperty(campo);
    expect(f.tx.desafioPalpite.findMany).not.toHaveBeenCalled();
  });

  it('deriva andamento exatamente no kickoff e preserva visibilidade apos referencia final', async () => {
    const f = setup();
    f.state.desafios[0].dataInicio = new Date(+agora + 1);
    expect((await f.service.buscar(7)).status).toBe('ABERTO');
    jest.setSystemTime(new Date(+agora + 1));
    expect((await f.service.buscar(7)).status).toBe('EM_ANDAMENTO');
    jest.setSystemTime(f.state.desafios[0].dataFim);
    expect((await f.service.listar(new ListarDesafiosQueryDto())).itens[0].status).toBe('EM_ANDAMENTO');
    expect((await f.service.buscar(7)).status).toBe('EM_ANDAMENTO');
    f.state.partidas[0].dataInicio = new Date(+f.state.desafios[0].dataFim + 1000);
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(ConflictException);
    expect((await f.service.buscar(7, 42)).partidas[0].podeAlterarPalpite).toBe(false);
  });

  it('lista publicados ABERTO/EM_ANDAMENTO inclusive apos dataFim enquanto apuracao esta pendente', async () => {
    const f = setup();
    f.state.desafios = [desafio(1), desafio(2, { status: 'EM_ANDAMENTO' }),
      desafio(3, { status: 'RASCUNHO' }), desafio(4, { status: 'CANCELADO' }), desafio(5, { status: 'ENCERRADO' }),
      desafio(6, { publicadoEm: null }), desafio(7, { publicadoEm: new Date(+agora + 1) }),
      desafio(8, { inicioInscricao: new Date(+agora + 1) }), desafio(9, { dataFim: agora }),
      desafio(10, { inicioInscricao: agora, publicadoEm: agora })];
    const result = await f.service.listar(new ListarDesafiosQueryDto());
    expect(result.itens.map(d => d.id)).toEqual([1, 2, 9, 10]);
    expect(result.paginacao).toEqual({ pagina: 1, limite: 20, total: 4, totalPaginas: 1 });
    const consulta = f.tx.desafio.findMany.mock.calls[0][0];
    expect(consulta.where).toEqual({ status: { in: ['ABERTO', 'EM_ANDAMENTO'] }, publicadoEm: { lte: agora },
      inicioInscricao: { lte: agora } });
    expect(consulta).toMatchObject({ orderBy: [{ dataInicio: 'asc' }, { id: 'asc' }] });
    expect(f.tx.desafio.count.mock.calls[0][0].where).toEqual(consulta.where);
    expect(result.itens[0]).not.toHaveProperty('criadoPorId');
    expect(result.itens[0]).not.toHaveProperty('publicadoEm');
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('pagina e filtra FREE/PAGO sem expor configuracao interna', async () => {
    const f = setup();
    f.state.desafios.push(desafio(8, { tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal('2') }),
      desafio(9, { tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal('3.5') }));
    const result = await f.service.listar({ pagina: 2, limite: 1, tipoAcesso: 'PAGO' });
    expect(result.itens).toHaveLength(1);
    expect(result.itens[0]).toMatchObject({ id: 9, valorInscricao: '3.50' });
    expect(result.paginacao).toEqual({ pagina: 2, limite: 1, total: 2, totalPaginas: 2 });
  });

  it('retorna detalhe publico ordenado sem consultar palpites e sem campos internos', async () => {
    const f = setup();
    f.state.partidas = [partida(2, { ordem: 1 }), partida(1, { ordem: 1 }), partida(3, { ordem: 2 })];
    f.state.palpites = [palpite()];
    const result = await f.service.buscar(7);
    expect(result.partidas.map(p => p.id)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ valorInscricao: '0.00', dataInicio: '2030-10-03T11:00:00.000Z' });
    expect(result.partidas[0]).toEqual({ id: 1, ordem: 1, nomeCompeticao: 'Serie A', nomeMandante: 'Mandante',
      logoMandanteUrl: 'https://example.com/home.png', nomeVisitante: 'Visitante', logoVisitanteUrl: null,
      dataInicio: '2030-10-03T16:00:00.000Z', status: 'AGENDADA', statusInterno: 'AGENDADA',
      golsMandante: null, golsVisitante: null, fechamentoEm: '2030-10-03T16:00:00.000Z', podeAlterarPalpite: false });
    expect(f.tx.desafioPalpite.findMany).not.toHaveBeenCalled();
    expect(f.tx.desafioInscricao.findUnique).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('inscrito');
    expect(result).not.toHaveProperty('minhaInscricao');
    expect(f.tx.desafio.findFirst.mock.calls[0][0]).toMatchObject({ select: { partidas: { orderBy: [{ ordem: 'asc' }, { id: 'asc' }] } } });
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('inclui somente meus palpites, inclusive fechados, sem depender de inscricao', async () => {
    const f = setup();
    f.state.partidas = [partida(1, { dataInicio: agora }), partida(2), partida(3)];
    f.state.inscricoes = [inscricao()];
    f.state.palpites = [palpite(), palpite(42, 2, { palpite: 'EMPATE' }), palpite(43, 3, { palpite: 'FORA' }),
      palpite(42, 3, { desafioId: 8, palpite: 'CASA' })];
    const result = await f.service.buscar(7, 42);
    expect(result.partidas.map(p => [p.meuPalpite, p.podeAlterarPalpite])).toEqual([['CASA', false], ['EMPATE', true], [null, true]]);
    expect(result).toMatchObject({ inscrito: false, minhaInscricao: null });
    expect(f.tx.desafioPalpite.findMany).toHaveBeenCalledWith({ where: { desafioId: 7, usuarioId: 42 },
      select: { inscricaoId: true, desafioPartidaId: true, palpite: true, pontos: true, apurado: true } });
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('detalhe informa somente a minha inscricao, sem IDs financeiros ou dados de outro usuario', async () => {
    const f = setup();
    const inscricao: DesafioInscricao = { id: 10, desafioId: 7, usuarioId: 42, status: 'ATIVA', sequencia: 1, chaveIdempotencia: null,
      valorInscricao: new Prisma.Decimal('2.00'), movimentacaoDebitoId: 100,
      dataInscricao: agora, criadoEm: agora, atualizadoEm: agora };
    f.state.inscricoes = [inscricao, { ...inscricao, id: 11, usuarioId: 43 }];
    expect(await f.service.buscar(7, 42)).toMatchObject({ inscrito: true, minhaInscricao: {
      id: 10, desafioId: 7, status: 'ATIVA', valorInscricao: '2.00', dataInscricao: agora.toISOString(),
    } });
    expect((await f.service.buscar(7, 42)).minhaInscricao).not.toHaveProperty('movimentacaoDebitoId');
    expect((await f.service.buscar(7, 42)).minhaInscricao).not.toHaveProperty('usuarioId');
    expect(await f.service.buscar(7, 99)).toMatchObject({ inscrito: false, minhaInscricao: null });
    inscricao.status = 'CANCELADA';
    expect(await f.service.buscar(7, 42)).toMatchObject({ inscrito: false, minhaInscricao: { status: 'CANCELADA' } });
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'FORA' })).rejects.toBeInstanceOf(ConflictException);
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it.each<Partial<Desafio>>([{ status: 'RASCUNHO' }, { status: 'CANCELADO' }, { status: 'ENCERRADO' },
    { publicadoEm: null }, { publicadoEm: new Date(+agora + 1) }, { inicioInscricao: new Date(+agora + 1) }])
  ('oculta detalhe indisponivel e recusa gravacao: %j', async change => {
    const f = setup(); Object.assign(f.state.desafios[0], change);
    await expect(f.service.buscar(7, 42)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.desafioPalpite.findMany).not.toHaveBeenCalled();
    expect(f.tx.desafioPalpite.upsert).not.toHaveBeenCalled();
  });

  it.each(['FREE', 'PAGO'] as const)('cria e altera um palpite em %s sem inscricao, preenchimento total ou financeiro', async tipoAcesso => {
    const f = setup(); Object.assign(f.state.desafios[0], { tipoAcesso, valorInscricao: new Prisma.Decimal(tipoAcesso === 'FREE' ? 0 : 2) });
    f.state.partidas.push(partida(2));
    expect(await f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' })).toEqual({ desafioId: 7, partidaId: 1,
      palpite: 'CASA', fechamentoEm: '2030-10-03T16:00:00.000Z', podeAlterarPalpite: true });
    const originalId = f.state.palpites[0].id;
    for (const valor of ['EMPATE', 'FORA'] as const) {
      await expect(f.service.salvarPalpite(7, 1, 42, { palpite: valor })).resolves.toMatchObject({ palpite: valor });
    }
    expect(f.state.palpites).toHaveLength(1);
    expect(f.state.palpites[0]).toMatchObject({ id: originalId, usuarioId: 42, palpite: 'FORA', apurado: false, pontos: null });
    expect(f.tx.desafioPalpite.upsert.mock.calls[0][0]).toEqual({
      where: { inscricaoId_desafioPartidaId: { desafioPartidaId: 1, inscricaoId: 42 } },
      create: { desafioId: 7, desafioPartidaId: 1, usuarioId: 42, inscricaoId: 42, palpite: 'CASA' }, update: { palpite: 'CASA' }, select: { palpite: true },
    });
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('isola usuarios e preserva unicidade em gravacoes concorrentes', async () => {
    const f = setup();
    await Promise.all([f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' }),
      f.service.salvarPalpite(7, 1, 42, { palpite: 'EMPATE' }), f.service.salvarPalpite(7, 1, 43, { palpite: 'FORA' })]);
    expect(f.state.palpites.map(p => [p.usuarioId, p.palpite])).toEqual([[42, 'EMPATE'], [43, 'FORA']]);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
    expect(f.tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FROM DESAFIO WHERE ID = ? FOR UPDATE');
    expect(f.tx.$queryRaw.mock.calls[1][0].join('?')).toContain('FROM DESAFIO_PARTIDA WHERE ID = ? AND DESAFIO_ID = ? FOR UPDATE');
    expect(f.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(f.tx.desafioPalpite.upsert.mock.invocationCallOrder[0]);
  });

  it('aceita 1ms antes e bloqueia criacao/alteracao exatamente no inicio e depois', async () => {
    const f = setup();
    f.state.partidas[0].dataInicio = new Date(+agora + 1);
    await f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' });
    for (const offset of [1, 2]) {
      jest.setSystemTime(new Date(+agora + offset));
      for (const usuarioId of [42, 43]) {
        await expect(f.service.salvarPalpite(7, 1, usuarioId, { palpite: 'FORA' })).rejects.toBeInstanceOf(ConflictException);
      }
      expect((await f.service.buscar(7, 42)).partidas[0].podeAlterarPalpite).toBe(false);
    }
    expect(f.state.palpites).toHaveLength(1);
    expect(f.state.palpites[0].palpite).toBe('CASA');
  });

  it.each(['ABERTO', 'EM_ANDAMENTO'] as const)('mantem jogos futuros abertos em %s apos inicio global/fimInscricao/outro jogo iniciado', async status => {
    const f = setup(); f.state.desafios[0].status = status;
    f.state.partidas = [partida(1, { status: 'EM_ANDAMENTO', dataInicio: new Date(+agora - 1) }), partida(2)];
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.salvarPalpite(7, 2, 42, { palpite: 'EMPATE' })).resolves.toMatchObject({ palpite: 'EMPATE' });
    expect((await f.service.buscar(7, 42)).partidas.map(p => p.podeAlterarPalpite)).toEqual([false, true]);
  });

  it.each<Partial<DesafioPartida>>([{ status: 'ANULADA' }, { status: 'EM_ANDAMENTO' }, { status: 'FINALIZADA' },
    { resultado: 'CASA' }, { golsMandante: 0 }, { golsVisitante: 0 }])('rejeita partida inelegivel mesmo com horario futuro: %j', async change => {
    const f = setup(); Object.assign(f.state.partidas[0], change);
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(ConflictException);
    expect((await f.service.buscar(7, 42)).partidas[0].podeAlterarPalpite).toBe(false);
    expect(f.tx.desafioPalpite.upsert).not.toHaveBeenCalled();
  });

  it('rejeita Desafio inexistente e partida ausente ou pertencente a outro Desafio', async () => {
    const f = setup(); f.state.partidas.push(partida(2, { desafioId: 8 }));
    await expect(f.service.buscar(999)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.salvarPalpite(999, 1, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(NotFoundException);
    for (const id of [2, 999]) await expect(f.service.salvarPalpite(7, id, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.desafioPalpite.upsert).not.toHaveBeenCalled();
  });

  it('revalida horario e cancelamento depois da espera pelos locks', async () => {
    const f = setup();
    f.tx.$queryRaw.mockImplementationOnce(async () => { jest.setSystemTime(f.state.partidas[0].dataInicio); return [{ ID: 7n }]; });
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.desafioPalpite.upsert).not.toHaveBeenCalled();
    jest.setSystemTime(agora);
    f.tx.$queryRaw.mockImplementationOnce(async () => { f.state.desafios[0].status = 'CANCELADO'; return [{ ID: 7n }]; });
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'CASA' })).rejects.toBeInstanceOf(ConflictException);
    expect(f.state.palpites).toEqual([]);
  });

  it('desfaz escrita que atravessa o instante de fechamento', async () => {
    const f = setup(); f.state.palpites = [palpite()];
    f.tx.desafioPalpite.upsert.mockImplementationOnce(async () => {
      f.state.palpites[0].palpite = 'FORA';
      jest.setSystemTime(f.state.partidas[0].dataInicio);
      return f.state.palpites[0];
    });
    await expect(f.service.salvarPalpite(7, 1, 42, { palpite: 'FORA' })).rejects.toBeInstanceOf(ConflictException);
    expect(f.state.palpites[0].palpite).toBe('CASA');
  });
});
