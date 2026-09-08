import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CartolaService } from '../src/cartola/cartola.service';
import { CartolaCacheService } from '../src/cartola/cartola-cache.service';
import { CartolaHttpClient } from '../src/cartola/cartola-http.client';
import { TeamDetailQueryDto } from '../src/cartola/dto/team-detail-query.dto';
import { teamDetailResponse } from '../src/cartola/team-detail-response';
import { PrismaService } from '../src/prisma/prisma.service';

function fixture(status: 'PARCIAL' | 'FINAL' = 'PARCIAL', active?: boolean, luxury = false, captain = false, score = 8.4) {
  const date = new Date('2026-09-08T00:00:00Z');
  const athlete = (id: number, titular: boolean) => ({ id, timeRodadaId: 1, atletaId: id,
    posicaoId: 5, clubeId: 1, titular, reserva: !titular, capitao: titular && captain,
    ordem: id, preco: new Prisma.Decimal(10), nome: titular ? 'Pedro' : 'Calleri', criadoEm: date, atualizadoEm: date });
  const team: Parameters<typeof teamDetailResponse>[0] = {
    id: 1, timeId: 99, temporada: 2026, rodada: 25, esquemaTatico: 3, patrimonio: new Prisma.Decimal(100),
    capitaoId: captain ? 123 : null, reservaLuxoId: luxury ? 456 : null, status: 'CAPTURADO', criadoEm: date, atualizadoEm: date,
    time: { timeId: 99, nomeTime: 'Time de teste', nomeCartoleiro: 'Teste', slug: null, escudoUrl: null,
      fotoPerfilUrl: null, assinante: false, criadoEm: date, atualizadoEm: date },
    escalacao: [athlete(123, true), athlete(456, false)],
    pontuacao: { id: 1, timeRodadaId: 1, pontuacao: new Prisma.Decimal(12.6), status,
      criadoEm: date, atualizadoEm: date, consolidadoEm: status === 'FINAL' ? date : null },
    substituicoes: active === undefined ? [] : [{ id: 1, timeRodadaId: 1, atletaSaiuId: 123,
      atletaEntrouId: 456, posicaoId: 5, ativa: active, criadoEm: date, atualizadoEm: date }],
  };
  const payload = { rodada: 25, atletas: { '123': { pontuacao: score }, '456': { pontuacao: score } } };
  return { team, payload };
}

describe('Contrato efetivo do detalhe', () => {
  it.each(['PARCIAL', 'FINAL'] as const)('preserva composicao original e total persistido em %s', (status) => {
    const { team, payload } = fixture(status);
    const result = teamDetailResponse(team, payload);
    expect(result.status).toBe(status);
    expect(result.pontos).toBe(12.6);
    expect(result.substituicoes).toEqual([]);
    expect(result.atletas[0]).toMatchObject({ atleta_id: 123, titularEfetivo: true, pontuacaoContabilizada: 8.4 });
    expect(result.reservas[0]).toMatchObject({ atleta_id: 456, titularEfetivo: false, pontuacaoContabilizada: 0 });
  });
  it('expoe substituicao normal ativa sem duplicar atletas', () => {
    const { team, payload } = fixture('PARCIAL', true);
    const result = teamDetailResponse(team, payload);
    expect(result.substituicoes).toEqual([{ ativa: true, titularSaiuId: 123, reservaEntrouId: 456, reservaLuxo: false, herdouCapitao: false }]);
    expect(result.atletas[0]).toMatchObject({ titularEfetivo: false, pontuacaoContabilizada: 0 });
    expect(result.reservas[0]).toMatchObject({ titularEfetivo: true, pontuacaoContabilizada: 8.4 });
    const ids = [...result.atletas, ...result.reservas].map((a) => a.atleta_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('ignora substituicao inativa', () => {
    const { team, payload } = fixture('PARCIAL', false, true, true);
    const result = teamDetailResponse(team, payload);
    expect(result.substituicoes).toEqual([]);
    expect(result.atletas[0]).toMatchObject({ capitaoEfetivo: true, pontuacaoContabilizada: 12.6 });
    expect(result.reservas[0]).toMatchObject({ titularEfetivo: false, capitaoEfetivo: false, reservaLuxoUtilizado: false });
  });
  it.each([true, false])('identifica reserva de luxo utilizado=%s', (active) => {
    const { team, payload } = fixture('PARCIAL', active, true);
    const result = teamDetailResponse(team, payload);
    expect(result.reservas[0]).toMatchObject({ reservaLuxo: true, reservaLuxoUtilizado: active });
    if (active) expect(result.substituicoes[0].reservaLuxo).toBe(true);
  });
  it('informa capitao herdado e contribuicao multiplicada pelo motor existente', () => {
    const { team, payload } = fixture('FINAL', true, true, true);
    const result = teamDetailResponse(team, payload);
    expect(result.capitao_id).toBe(123);
    expect(result.substituicoes[0].herdouCapitao).toBe(true);
    expect(result.atletas[0]).toMatchObject({ capitaoOriginal: true, capitaoEfetivo: false, pontuacaoContabilizada: 0 });
    expect(result.reservas[0]).toMatchObject({ capitaoOriginal: false, capitaoEfetivo: true, pontos_num: 8.4, pontuacaoContabilizada: 12.6 });
  });
  it('preserva pontuacao negativa do capitao', () => {
    const { team, payload } = fixture('PARCIAL', undefined, false, true, -2.1);
    expect(teamDetailResponse(team, payload).atletas[0]).toMatchObject({ pontos_num: -2.1, pontuacaoContabilizada: -3.15 });
  });
  it('informa participacao usando apenas os atletas efetivos', () => {
    const { team, payload } = fixture('PARCIAL', true);
    const scores = { ...payload, atletas: {
      '123': { pontuacao: 0, entrou_em_campo: false },
      '456': { pontuacao: 8.4, entrou_em_campo: true },
    } };
    expect(teamDetailResponse(team, scores).jogadores_jogaram).toBe(1);
  });
});

describe('Consulta do detalhe persistido', () => {
  function setup(status: 'PARCIAL' | 'FINAL') {
    const { team, payload } = fixture(status, true, true, true);
    const tx = { rodadaProcessamento: { findFirst: jest.fn().mockResolvedValue({ temporada: 2026, rodada: 25,
      status: status === 'FINAL' ? 'CONSOLIDADA' : 'EM_ANDAMENTO', pontuados: payload }) },
    timeRodada: { findUnique: jest.fn().mockResolvedValue(team) } };
    const prisma = { $transaction: jest.fn(async (read: (db: typeof tx) => unknown) => read(tx)) };
    const http = { get: jest.fn().mockRejectedValue(new Error('Nao deve consultar Cartola')) };
    const service = new CartolaService(http as unknown as CartolaHttpClient, new CartolaCacheService(), prisma as unknown as PrismaService);
    return { tx, prisma, http, service };
  }
  it.each(['PARCIAL', 'FINAL'] as const)('%s usa somente MySQL, em leitura consistente, sem N+1', async (status) => {
    const { service, http, tx, prisma } = setup(status);
    const result = await service.getTeamDetail(99, { temporada: 2026, rodada: 25 });
    expect(result.value.status).toBe(status);
    expect(result.value.substituicoes).toHaveLength(1);
    expect(http.get).not.toHaveBeenCalled();
    expect(tx.rodadaProcessamento.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.timeRodada.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.timeRodada.findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({
      substituicoes: { where: { ativa: true }, orderBy: { id: 'asc' } },
    }) }));
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });
  it('sem filtros seleciona a ultima rodada persistida', async () => {
    const { service, http, tx } = setup('PARCIAL');
    await service.getTeamDetail(99);
    expect(tx.rodadaProcessamento.findFirst).toHaveBeenCalledWith({ where: { temporada: undefined, rodada: undefined },
      orderBy: [{ temporada: 'desc' }, { rodada: 'desc' }] });
    expect(http.get).not.toHaveBeenCalled();
  });
  it('nao reconstroi historico ausente ou incompleto pela rede', async () => {
    const { service, http, tx } = setup('FINAL');
    tx.timeRodada.findUnique.mockResolvedValueOnce(null);
    await expect(service.getTeamDetail(99)).rejects.toThrow('historico');
    tx.rodadaProcessamento.findFirst.mockResolvedValueOnce({ temporada: 2026, rodada: 25, status: 'CONSOLIDADA', pontuados: null });
    await expect(service.getTeamDetail(99)).rejects.toThrow('aguardando');
    tx.rodadaProcessamento.findFirst.mockResolvedValueOnce(null);
    await expect(service.getTeamDetail(99, { temporada: 2025, rodada: 1 })).rejects.toThrow('Snapshot');
    expect(http.get).not.toHaveBeenCalled();
  });
  it('preserva fallback legado somente sem filtros e sem snapshot', async () => {
    const { service, http, tx } = setup('PARCIAL');
    tx.timeRodada.findUnique.mockResolvedValue(null);
    http.get.mockResolvedValueOnce({ time: { time_id: 99 }, atletas: [] } as never);
    const result = await service.getTeamDetail(99);
    expect(result.value).toEqual({ time: { time_id: 99 }, atletas: [] });
    expect(result.value.substituicoes).toBeUndefined();
  });
  it.each([{ rodada: '0' }, { rodada: '39' }, { rodada: '1.5' }, { temporada: 'abc' }])('valida filtros %j', async (query) => {
    expect(await validate(plainToInstance(TeamDetailQueryDto, query))).not.toHaveLength(0);
  });
});
