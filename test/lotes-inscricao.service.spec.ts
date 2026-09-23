import { Prisma } from '@prisma/client';
import { lotesFixture } from './helpers/lotes-inscricao.fixture';

describe('LotesInscricaoService', () => {
  let f: ReturnType<typeof lotesFixture>;
  const chave = 'compra-teste-123456';
  const dto = { timesCartolaIds: [456, 123], valorUnitarioEsperado: '10.00' };
  beforeEach(() => { f = lotesFixture(); });
  const criar = () => f.service.criar(1, 10, dto, chave);
  const semEfeitos = () => {
    expect(f.state.lotes).toEqual([]); expect(f.state.inscricoes).toEqual([]); expect(f.state.movimentos).toEqual([]);
    expect(f.state.carteira.saldoDisponivel.toFixed(2)).toBe('100.00');
  };

  it('inscreve varios times PAGO com um debito e uma transacao, persistindo resposta e confirmacao', async () => {
    const debitar = jest.spyOn(f.carteiras, 'debitarEmTransacao');
    const result = await criar();
    expect(result).toEqual({ loteId: 1, competicaoId: 1, quantidade: 2, tipoAcesso: 'PAGO', moeda: 'BRL',
      valorUnitario: '10.00', valorTotal: '20.00', movimentacaoDebitoId: 1, saldoDisponivelAposOperacao: '80.00',
      inscricoes: [{ id: 1, timeIdCartola: 123, statusInscricao: 'ATIVA' }, { id: 2, timeIdCartola: 456, statusInscricao: 'ATIVA' }] });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(debitar).toHaveBeenCalledTimes(1);
    expect(debitar).toHaveBeenCalledWith(f.tx, expect.objectContaining({ usuarioId: 10, origem: 'INSCRICAO', valor: new Prisma.Decimal(20) }));
    expect(f.state.lotes[0]).toMatchObject({ confirmadoEm: expect.any(Date), respostaOriginal: result });
    expect(f.state.inscricoes.every(row => row.loteInscricaoId === 1)).toBe(true);
    const queries = f.tx.$queryRaw.mock.calls.map(([sql]: [TemplateStringsArray]) => sql.join('?'));
    expect(queries[0]).toContain('FROM COMPETICAO_LIGA');
    expect(queries[1]).toContain('FROM USUARIO');
    expect(queries.every((query: string) => query.includes('FOR UPDATE'))).toBe(true);
    expect(queries.some((query: string) => query.includes('FROM TIME_USUARIO'))).toBe(true);
  });

  it('FREE cria lote sem consultar/criar carteira nem registrar movimentacao', async () => {
    Object.assign(f.competicao, { tipoAcesso: 'FREE', valorInscricao: new Prisma.Decimal(0) });
    expect(await f.service.criar(1, 10, { ...dto, valorUnitarioEsperado: '0.00' }, chave)).toMatchObject({
      valorTotal: '0.00', valorUnitario: '0.00', tipoAcesso: 'FREE', movimentacaoDebitoId: null, saldoDisponivelAposOperacao: null,
    });
    expect(f.tx.carteira.upsert).not.toHaveBeenCalled();
    expect(f.state.movimentos).toEqual([]);
  });

  it('saldo insuficiente retorna valores e reverte o lote completo', async () => {
    f.state.carteira.saldoDisponivel = new Prisma.Decimal('7.50');
    await expect(criar()).rejects.toMatchObject({ response: { statusCode: 409, code: 'SALDO_INSUFICIENTE',
      saldoDisponivel: '7.50', valorNecessario: '20.00', valorFaltante: '12.50', moeda: 'BRL' } });
    expect(f.state.inscricoes).toEqual([]); expect(f.state.lotes).toEqual([]); expect(f.state.movimentos).toEqual([]);
    expect(f.state.carteira.saldoDisponivel.toFixed(2)).toBe('7.50');
    expect(f.tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
    f.state.carteira.saldoDisponivel = new Prisma.Decimal(100);
    await expect(criar()).resolves.toMatchObject({ quantidade: 2 });
  });

  it('preco divergente e rejeitado antes de criar lote, inscricoes ou debitar', async () => {
    await expect(f.service.criar(1, 10, { ...dto, valorUnitarioEsperado: '9.00' }, chave)).rejects.toMatchObject({
      response: { code: 'PRECO_INSCRICAO_ALTERADO', valorEsperado: '9.00', valorAtual: '10.00', quantidade: 2, valorTotalAtual: '20.00' },
    });
    expect(f.tx.loteInscricao.create).not.toHaveBeenCalled(); semEfeitos();
  });

  it('preco omitido usa o valor vigente e soma centavos com Decimal', async () => {
    f.competicao.valorInscricao = new Prisma.Decimal('0.10');
    expect(await f.service.criar(1, 10, { timesCartolaIds: [123, 456] }, chave)).toMatchObject({ valorUnitario: '0.10', valorTotal: '0.20' });
  });

  it('mesma chave e conjunto de times em outra ordem reproduz exatamente a resposta mesmo apos fechamento', async () => {
    const first = await criar();
    f.competicao.status = 'ENCERRADA'; f.competicao.valorInscricao = new Prisma.Decimal(99);
    f.state.carteira.saldoDisponivel = new Prisma.Decimal(1);
    expect(await f.service.criar(1, 10, { ...dto, timesCartolaIds: [123, 456] }, chave)).toEqual(first);
    expect(f.state.movimentos).toHaveLength(1);
    expect(f.tx.loteInscricao.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1, { timesCartolaIds: [123], valorUnitarioEsperado: '10.00' }],
    [2, dto], [1, { ...dto, valorUnitarioEsperado: '11.00' }], [1, { timesCartolaIds: [123, 456] }],
  ] as const)('rejeita reutilizacao da chave para outro conteudo: %j %j', async (competicao, body) => {
    await criar();
    await expect(f.service.criar(competicao, 10, { ...body, timesCartolaIds: [...body.timesCartolaIds] }, chave)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUTILIZADA' } });
    expect(f.state.movimentos).toHaveLength(1);
  });

  it('reverifica idempotencia depois dos locks quando a primeira leitura nao encontrou a operacao', async () => {
    const first = await criar();
    f.tx.loteInscricao.findUnique.mockResolvedValueOnce(null);
    expect(await criar()).toEqual(first);
    expect(f.state.movimentos).toHaveLength(1);
  });

  it('retry de conflito transacional apos debito reexecuta tudo sem cobrar duas vezes', async () => {
    const original = f.tx.loteInscricao.update.getMockImplementation();
    let falhar = true;
    f.tx.loteInscricao.update.mockImplementation(async (args: any) => {
      if (args.data.confirmadoEm && falhar) {
        falhar = false;
        throw new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'test' });
      }
      return original(args);
    });
    await expect(criar()).resolves.toMatchObject({ saldoDisponivelAposOperacao: '80.00' });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(f.state.movimentos).toHaveLength(1); expect(f.state.inscricoes).toHaveLength(2);
  });

  it('limita retries transacionais e orienta repetir com a mesma chave', async () => {
    f.tx.loteInscricao.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'test' }));
    await expect(criar()).rejects.toMatchObject({ response: { code: 'INSCRICAO_CONCORRENTE' } });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(3); semEfeitos();
  });

  it('rejeita total que ultrapassa Decimal(12,2) antes das escritas', async () => {
    f.competicao.valorInscricao = new Prisma.Decimal('9999999999.99');
    await expect(f.service.criar(1, 10, { timesCartolaIds: [123, 456] }, chave))
      .rejects.toMatchObject({ response: { code: 'VALOR_LOTE_INVALIDO' } }); semEfeitos();
  });

  it.each([null, { status: 'BLOQUEADO' }, { status: 'INATIVO' }])('revalida usuario dentro da transacao: %j', async usuario => {
    f.tx.usuario.findUnique.mockResolvedValue(usuario);
    await expect(criar()).rejects.toBeInstanceOf(Error); semEfeitos();
  });

  it.each(['inscricao', 'debito', 'confirmacao'] as const)('propaga falha em %s e reverte todos os efeitos simulados', async etapa => {
    if (etapa === 'inscricao') {
      const original = f.tx.inscricaoTimeCompeticao.create.getMockImplementation();
      f.tx.inscricaoTimeCompeticao.create.mockImplementationOnce(original).mockRejectedValueOnce(new Error('falha injetada'));
    } else if (etapa === 'debito') {
      f.tx.movimentacaoCarteira.create.mockRejectedValueOnce(new Error('falha injetada'));
    } else {
      const original = f.tx.loteInscricao.update.getMockImplementation();
      f.tx.loteInscricao.update.mockImplementation(async (args: any) => {
        if (args.data.confirmadoEm) throw new Error('falha injetada'); return original(args);
      });
    }
    await expect(criar()).rejects.toThrow('falha injetada'); semEfeitos();
  });

  it.each([
    ['limiteTimesUsuario', 1, 'LIMITE_TIMES_USUARIO_ATINGIDO'],
    ['limiteParticipantes', 1, 'LIMITE_PARTICIPANTES_ATINGIDO'],
  ])('rejeita lote inteiro por %s', async (campo, limite, code) => {
    f.competicao[campo] = limite;
    await expect(criar()).rejects.toMatchObject({ response: { code } }); semEfeitos();
  });

  it('time fora de TIME_USUARIO impede o lote inteiro', async () => {
    f.times.pop();
    await expect(criar()).rejects.toMatchObject({ response: { code: 'TIME_NAO_PERTENCE_AO_USUARIO' } }); semEfeitos();
  });

  it('time ja inscrito impede o lote inteiro, inclusive cancelado', async () => {
    f.tx.inscricaoTimeCompeticao.findMany.mockResolvedValue([{ timeIdCartola: 123 }]);
    await expect(criar()).rejects.toMatchObject({ response: { code: 'TIME_JA_INSCRITO' } }); semEfeitos();
  });

  it('carteira bloqueada reverte inscricoes criadas e nao debita', async () => {
    f.state.carteira.status = 'BLOQUEADA';
    await expect(criar()).rejects.toMatchObject({ response: { code: 'CARTEIRA_BLOQUEADA' } }); semEfeitos();
  });

  it.each([
    { status: 'ENCERRADA' }, { visivelApp: false }, { fimInscricao: new Date('2000-01-01') },
    { inicioInscricao: new Date('2999-01-01') }, { tipoAcesso: 'FREE' }, { valorInscricao: new Prisma.Decimal(0) },
    { ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: false }, modalidade: { ativa: true } } },
  ])('rejeita competicao indisponivel %j', async change => {
    Object.assign(f.competicao, change); await expect(criar()).rejects.toBeInstanceOf(Error); semEfeitos();
  });

  it.each([undefined, '', 'curta', 'x'.repeat(129), 'invalida chave 123456'])('rejeita chave invalida %s', async key => {
    await expect(f.service.criar(1, 10, dto, key)).rejects.toMatchObject({ status: 400 }); semEfeitos();
  });

  it.each([
    { timesCartolaIds: [] }, { timesCartolaIds: [123, 123] }, { timesCartolaIds: Array.from({ length: 51 }, (_, i) => i + 1) },
    { timesCartolaIds: [0] }, { timesCartolaIds: [1.5] }, { timesCartolaIds: ['123'] },
    { ...dto, valorUnitarioEsperado: null }, { ...dto, valorUnitarioEsperado: 10 }, { ...dto, valorUnitarioEsperado: '1.001' },
    { ...dto, usuarioId: 99 },
  ])('valida o DTO mesmo em chamada interna: %j', async body => {
    await expect(f.service.criar(1, 10, body as any, chave)).rejects.toMatchObject({ status: 400 }); semEfeitos();
  });

  it.each(['movimento', 'titularidade', 'soma', 'usuario', 'competicao', 'lote'] as const)('reverte se a invariante %s falhar', async campo => {
    const original = f.tx.loteInscricao.findUniqueOrThrow.getMockImplementation();
    f.tx.loteInscricao.findUniqueOrThrow.mockImplementation(async (args: any) => {
      const row = await original(args);
      if (campo === 'movimento') row.movimentacaoDebito.tipo = 'CREDITO';
      else if (campo === 'titularidade') row.movimentacaoDebito.carteira = { ...row.movimentacaoDebito.carteira, usuarioId: 99 };
      else row.inscricoes = row.inscricoes.map((item: any, i: number) => i ? item : { ...item,
        ...(campo === 'soma' ? { valorInscricao: new Prisma.Decimal(1) } :
          campo === 'usuario' ? { usuarioId: 99 } : campo === 'competicao' ? { competicaoLigaId: 99 } : { loteInscricaoId: 99 }),
      });
      return row;
    });
    await expect(criar()).rejects.toMatchObject({ response: { code: 'INCONSISTENCIA_FINANCEIRA' } }); semEfeitos();
  });
});
