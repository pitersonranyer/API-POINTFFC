import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminDashboardFinanceiroService } from '../src/admin/admin-dashboard-financeiro.service';
import { DashboardFinanceiroQueryDto } from '../src/admin/dto/admin-dashboard-financeiro.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const decimal = (valor: string) => new Prisma.Decimal(valor);
const competicao = (id = 7, changes: Record<string, unknown> = {}) => ({
  id, nome: `Competicao ${id}`, rodadaInicio: 27, rodadaFim: 28, status: 'INSCRICOES_ABERTAS',
  tipoAcesso: 'PAGO', valorInscricao: decimal('999.00'), tipoTaxaPlataforma: null, valorTaxaPlataforma: null,
  ligaModalidade: { liga: { id: 1, nome: 'POINT FFC' }, modalidade: { id: 2, codigo: 'RODADA', nome: 'Rodada' } },
  ...changes,
});
const grupo = (statusInscricao: string, quantidade: number, valor: string, competicaoLigaId = 7) => ({
  competicaoLigaId, statusInscricao, _count: { _all: quantidade }, _sum: { valorInscricao: decimal(valor) },
});
const fixo = (valor: string, inicio = 1, fim = inicio) => ({
  competicaoLigaId: 7, posicaoInicio: inicio, posicaoFim: fim, tipoPremiacao: 'VALOR_FIXO',
  valor: decimal(valor), percentual: null, ordem: inicio,
});
const percentual = (valor: string, posicao = 1) => ({
  ...fixo('0', posicao), tipoPremiacao: 'PERCENTUAL', valor: null, percentual: decimal(valor),
});

describe('AdminDashboardFinanceiroService', () => {
  const tx = { competicaoLiga: { findMany: jest.fn() }, inscricaoTimeCompeticao: { groupBy: jest.fn() },
    premiacaoCompeticao: { findMany: jest.fn() } };
  const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
  const service = new AdminDashboardFinanceiroService(prisma as unknown as PrismaService);
  const consultar = (query: Partial<DashboardFinanceiroQueryDto> = {}) => service.consultar({ pagina: 1, limite: 20, ...query });

  beforeEach(() => {
    jest.clearAllMocks();
    tx.competicaoLiga.findMany.mockResolvedValue([competicao()]);
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([grupo('ATIVA', 10, '1000')]);
    tx.premiacaoCompeticao.findMany.mockResolvedValue([]);
  });

  it('FREE sem taxa ou premios retorna valores zerados e natureza nominal', async () => {
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7, { tipoAcesso: 'FREE', valorInscricao: decimal('0') })]);
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([grupo('ATIVA', 10, '0')]);
    const result = await consultar();
    expect(result.natureza).toBe('PREVISTO_NOMINAL');
    expect(result.totalizadores).toEqual({ quantidadeCompeticoes: 1, totalInscritos: 10, inscricoesCanceladas: 0,
      valorInscricoes: '0.00', receitaPointPrevista: '0.00', basePremiacao: '0.00', premiacaoCalculada: '0.00', saldoAposPremiacao: '0.00' });
  });

  it.each([
    ['PERCENTUAL', '10', '100.00', '900.00'],
    ['VALOR_FIXO', '3.50', '35.00', '965.00'],
  ])('calcula taxa %s a partir do snapshot e quantidade considerada', async (tipo, valor, receita, base) => {
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7, { tipoTaxaPlataforma: tipo, valorTaxaPlataforma: decimal(valor) })]);
    const result = await consultar();
    expect(result.itens[0].valorInscricao).toBe('999.00');
    expect(result.itens[0].financeiro).toMatchObject({ valorInscricoes: '1000.00', receitaPointPrevista: receita, basePremiacao: base });
  });

  it.each([
    ['fixo individual', [fixo('50')], '50.00'],
    ['fixo por faixa', [fixo('50', 4, 10)], '350.00'],
    ['percentual por posicao e soma menor que 100', [percentual('40'), percentual('25', 2)], '585.00'],
    ['mista', [percentual('40'), fixo('50', 4, 10)], '710.00'],
  ])('calcula premiacao %s sobre base apos taxa', async (_nome, premios, esperado) => {
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7, { tipoTaxaPlataforma: 'PERCENTUAL', valorTaxaPlataforma: decimal('10') })]);
    tx.premiacaoCompeticao.findMany.mockResolvedValue(premios);
    const result = await consultar();
    expect(result.totalizadores.premiacaoCalculada).toBe(esperado);
    expect(result.itens[0].premiacoes.reduce((soma, premio) => soma.plus(premio.valorCalculado), decimal('0')).toFixed(2)).toBe(esperado);
  });

  it('considera FINALIZADA, separa CANCELADA e cobra taxa fixa somente das consideradas', async () => {
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7, { tipoTaxaPlataforma: 'VALOR_FIXO', valorTaxaPlataforma: decimal('2') })]);
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([
      grupo('ATIVA', 2, '20'), grupo('FINALIZADA', 3, '45'), grupo('CANCELADA', 4, '400'),
    ]);
    const result = await consultar();
    expect(result.itens[0].inscritos).toEqual({ ativos: 2, finalizados: 3, cancelados: 4, totalConsiderado: 5 });
    expect(result.totalizadores).toMatchObject({ totalInscritos: 5, inscricoesCanceladas: 4,
      valorInscricoes: '65.00', receitaPointPrevista: '10.00', basePremiacao: '55.00' });
  });

  it('preserva saldo negativo e premios fixos mesmo sem inscritos suficientes', async () => {
    tx.premiacaoCompeticao.findMany.mockResolvedValue([fixo('200', 1, 10)]);
    expect((await consultar()).totalizadores.saldoAposPremiacao).toBe('-1000.00');
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([]);
    expect((await consultar()).totalizadores.saldoAposPremiacao).toBe('-2000.00');
  });

  it('nao limita base negativa nem percentuais calculados sobre ela', async () => {
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7, { tipoTaxaPlataforma: 'VALOR_FIXO', valorTaxaPlataforma: decimal('110') })]);
    tx.premiacaoCompeticao.findMany.mockResolvedValue([percentual('50')]);
    expect((await consultar()).totalizadores).toMatchObject({ basePremiacao: '-100.00', premiacaoCalculada: '-50.00', saldoAposPremiacao: '-50.00' });
  });

  it.each([
    [{ ligaId: 1 }, { ligaModalidade: { ligaId: 1 } }],
    [{ competicaoId: 7 }, { id: 7 }],
    [{ rodada: 27 }, { rodadaInicio: { lte: 27 }, rodadaFim: { gte: 27 } }],
    [{ ligaId: 1, competicaoId: 7, rodada: 27 }, { ligaModalidade: { ligaId: 1 }, id: 7, rodadaInicio: { lte: 27 }, rodadaFim: { gte: 27 } }],
  ])('aplica filtros AND em todas as consultas: %j', async (query, where) => {
    await consultar(query);
    expect(tx.competicaoLiga.findMany.mock.calls[0][0]).toMatchObject({ where, orderBy: { id: 'asc' } });
    expect(tx.competicaoLiga.findMany.mock.calls[0][0].where).toEqual(where);
    expect(tx.inscricaoTimeCompeticao.groupBy.mock.calls[0][0]).toMatchObject({ where: { competicaoLiga: where }, by: ['competicaoLigaId', 'statusInscricao'] });
    expect(tx.premiacaoCompeticao.findMany.mock.calls[0][0]).toMatchObject({ where: { competicaoLiga: where } });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });

  it('totalizadores independem da pagina, inclusive pagina vazia, sem N+1', async () => {
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7), competicao(8)]);
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([grupo('ATIVA', 10, '1000'), grupo('FINALIZADA', 3, '60', 8)]);
    tx.premiacaoCompeticao.findMany.mockResolvedValue([fixo('50'), fixo('25', 2)]);
    const primeira = await consultar({ limite: 1 });
    const segunda = await consultar({ limite: 1, pagina: 2 });
    const vazia = await consultar({ limite: 1, pagina: 3 });
    expect(primeira.totalizadores).toEqual(segunda.totalizadores);
    expect(primeira.totalizadores).toEqual(vazia.totalizadores);
    expect(primeira.totalizadores).toMatchObject({ quantidadeCompeticoes: 2, totalInscritos: 13, valorInscricoes: '1060.00', premiacaoCalculada: '75.00' });
    expect(segunda.itens.map(item => item.competicaoId)).toEqual([8]);
    expect(vazia.itens).toEqual([]);
    expect(segunda.paginacao).toEqual({ pagina: 2, limite: 1, total: 2, totalPaginas: 2 });
    expect(tx.inscricaoTimeCompeticao.groupBy).toHaveBeenCalledTimes(3);
    expect(tx.premiacaoCompeticao.findMany).toHaveBeenCalledTimes(3);
  });

  it('retorna totalizadores zerados sem resultados', async () => {
    tx.competicaoLiga.findMany.mockResolvedValue([]);
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([]);
    const result = await consultar();
    expect(result.itens).toEqual([]);
    expect(result.paginacao.totalPaginas).toBe(0);
    expect(result.totalizadores).toMatchObject({ quantidadeCompeticoes: 0, valorInscricoes: '0.00' });
  });

  it('mantem precisao acima do limite seguro de Number e quatro casas percentuais', async () => {
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([grupo('ATIVA', 10000000, '9007199254740993.01')]);
    tx.premiacaoCompeticao.findMany.mockResolvedValue([percentual('0.0001')]);
    const result = await consultar();
    expect(result.totalizadores).toMatchObject({ valorInscricoes: '9007199254740993.01',
      premiacaoCalculada: '9007199254.74', saldoAposPremiacao: '9007190247541738.27' });
    expect(result.itens[0].premiacoes[0].percentual).toBe('0.0001');
  });

  it('arredonda HALF_UP a taxa e cada premio antes de somar, mantendo identidades', async () => {
    tx.inscricaoTimeCompeticao.groupBy.mockResolvedValue([grupo('ATIVA', 1, '0.05')]);
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7, { tipoTaxaPlataforma: 'PERCENTUAL', valorTaxaPlataforma: decimal('10') })]);
    tx.premiacaoCompeticao.findMany.mockResolvedValue([percentual('12.5'), percentual('12.5', 2)]);
    expect((await consultar()).totalizadores).toMatchObject({ valorInscricoes: '0.05', receitaPointPrevista: '0.01',
      basePremiacao: '0.04', premiacaoCalculada: '0.02', saldoAposPremiacao: '0.02' });
  });

  it('rejeita faixa percentual legada, inclusive fora da pagina, sem fabricar totais', async () => {
    tx.premiacaoCompeticao.findMany.mockResolvedValue([{ ...percentual('20'), posicaoFim: 10 }]);
    await expect(consultar({ pagina: 2 })).rejects.toThrow('competicao 7');
  });

  it.each([
    [percentual('60'), percentual('41', 2)],
    [fixo('10', 1, 3), fixo('20', 3, 5)],
    [{ ...fixo('10'), valor: null }],
  ])('rejeita grade legada invalida %j', async (...premios) => {
    tx.premiacaoCompeticao.findMany.mockResolvedValue(premios);
    await expect(consultar()).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejeita taxa legada incompleta', async () => {
    tx.competicaoLiga.findMany.mockResolvedValue([competicao(7, { tipoTaxaPlataforma: 'VALOR_FIXO' })]);
    await expect(consultar()).rejects.toBeInstanceOf(ConflictException);
  });
});
