import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { DesafioSyncService } from '../src/desafios/desafio-sync.service';
import { FootballDataClient } from '../src/futebol/football-data.client';
import { FootballDataError } from '../src/futebol/football-data.normalizer';
import { PrismaService } from '../src/prisma/prisma.service';
import { desafioApuracaoFixture, resultadoOficial } from './helpers/desafio-apuracao.fixture';

function fixture(enabled: boolean | string = true) {
  const f = desafioApuracaoFixture();
  f.prisma.futebolPartida = { findMany: jest.fn(async () => []) };
  f.prisma.desafio.findMany = jest.fn(async () => [{ ...f.state.desafio, partidas: f.state.partidas.map(p => ({ ...p })) }]);
  const config = { get: jest.fn(key => key === 'DESAFIOS_SYNC_SCHEDULER_ENABLED' ? enabled : false) };
  const sync = new DesafioSyncService(config as unknown as ConfigService, f.prisma as PrismaService,
    f.api as unknown as FootballDataClient, f.service);
  return { ...f, sync, config };
}

function interna(overrides: Record<string, unknown> = {}) {
  return { externalId: 100, status: 'IN_PLAY', dataHoraUtc: new Date('2030-10-01T12:00:00Z'),
    ultimaAtualizacaoApi: new Date('2030-10-01T14:59:00Z'), atualizadoEm: new Date('2030-10-01T15:00:00Z'),
    placarMandante: 2, placarVisitante: 1, competicao: { externalId: 2013, nome: 'Serie A' },
    timeMandante: { externalId: 1, nome: 'Casa' }, timeVisitante: { externalId: 2, nome: 'Fora' }, ...overrides };
}

describe('Sincronizacao automatica de Desafios', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2030-10-01T15:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('persiste parcial sem apurar e depois apura resultado oficial', async () => {
    const f = fixture(); f.api.buscarResultadosPorIds.mockResolvedValueOnce([resultadoOficial(100, 2, 1, 'IN_PLAY')]);
    await f.sync.evaluate();
    expect(f.state.partidas[0]).toMatchObject({ status: 'EM_ANDAMENTO', golsMandante: 2, golsVisitante: 1, resultado: null });
    expect(f.state.palpites.every(p => !p.apurado && p.pontos === null)).toBe(true);
    // O mock simula aqui o @updatedAt do Prisma apos a persistencia.
    f.state.partidas[0].atualizadoEm = new Date();
    await f.sync.evaluate();
    expect(f.api.buscarResultadosPorIds).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5 * 60_000);
    await f.sync.evaluate();
    expect(f.state.palpites.map(p => Number(p.pontos))).toEqual([1, 0, 0]);
    expect(f.state.desafio.status).toBe('ENCERRADO');
    await f.sync.evaluate();
    expect(f.api.buscarResultadosPorIds).toHaveBeenCalledTimes(2);
  });

  it.each([[1, 1, 'FINISHED', [0, 1, 0]], [0, 0, 'CANCELLED', [null, null, null]]])
  ('preserva empate/anulacao %s x %s %s', async (home, away, status, pontos) => {
    const f = fixture(); f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(100, home, away, status)]);
    await f.sync.evaluate();
    expect(f.state.palpites.map(p => p.pontos === null ? null : Number(p.pontos))).toEqual(pontos);
    expect(f.state.desafio.status).toBe('ENCERRADO');
  });

  it('multiplas inscricoes do mesmo usuario mantem pontos e ranking separados', async () => {
    const f = fixture(); f.state.palpites[1].usuarioId = 1; f.state.inscricoes[1].usuarioId = 1;
    f.state.inscricoes[1].usuario = f.state.inscricoes[0].usuario;
    await f.sync.evaluate();
    const ranking = await f.ranking.consultar(7, { pagina: 1, limite: 20 });
    expect(ranking.ranking.map(r => r.pontos)).toEqual([1, 0, 0]);
    expect(f.state.palpites.slice(0, 2).map(p => [p.inscricaoId, Number(p.pontos)])).toEqual([[1, 1], [2, 0]]);
  });

  it('desabilitado nao consulta banco e flag de futebol nao interfere', async () => {
    const f = fixture(false); await f.sync.evaluate(); expect(f.prisma.desafio.findMany).not.toHaveBeenCalled();
    const ativo = fixture('true'); await ativo.sync.evaluate(); expect(ativo.api.buscarResultadosPorIds).toHaveBeenCalled();
  });

  it('deduplica IDs entre desafios e mantem partidas resolvidas fora do lote', async () => {
    const f = fixture();
    f.state.partidas.push({ ...f.state.partidas[0], id: 2, fixtureIdApiFootball: 101, status: 'FINALIZADA' });
    f.prisma.desafio.findMany.mockImplementationOnce(async () => Array.from({ length: 2 }, () => ({ ...f.state.desafio, partidas: f.state.partidas.map(p => ({ ...p })) })));
    await f.sync.evaluate(); expect(f.api.buscarResultadosPorIds).toHaveBeenCalledWith([100]);
    expect(f.tx.desafioPartida.update).toHaveBeenCalledTimes(1);
  });

  it('ignora partidas futuras e aplica intervalo de uma hora a pendencias antigas', async () => {
    const f = fixture(); f.state.partidas[0].dataInicio = new Date('2030-10-02T12:00:00Z');
    await f.sync.evaluate(); expect(f.api.buscarResultadosPorIds).not.toHaveBeenCalled();
    f.state.partidas[0].dataInicio = new Date('2030-09-30T12:00:00Z');
    f.state.partidas[0].atualizadoEm = new Date('2030-10-01T14:30:00Z');
    await f.sync.evaluate(); expect(f.api.buscarResultadosPorIds).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3600_000); await f.sync.evaluate(); expect(f.api.buscarResultadosPorIds).toHaveBeenCalledTimes(1);
  });

  it.each(['NETWORK', 'TIMEOUT', 'RATE_LIMIT'] as const)('falha %s nao escreve e permite retry com backoff', async code => {
    const f = fixture(); f.api.buscarResultadosPorIds.mockRejectedValueOnce(new FootballDataError('erro', code));
    await f.sync.evaluate(); await f.sync.evaluate();
    expect(f.tx.desafioPartida.update).not.toHaveBeenCalled(); expect(f.api.buscarResultadosPorIds).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(15 * 60_000); await f.sync.evaluate(); expect(f.state.desafio.status).toBe('ENCERRADO');
  });

  it('resposta incompleta ou identidade divergente nao escreve', async () => {
    const f = fixture(); f.api.buscarResultadosPorIds.mockResolvedValueOnce([]);
    await f.sync.evaluate();
    f.api.buscarResultadosPorIds.mockResolvedValueOnce([{ ...resultadoOficial(), mandanteId: 999 }]);
    await f.sync.evaluate(); expect(f.tx.desafioPartida.update).not.toHaveBeenCalled();
  });

  it('FINISHED sem resultado regulamentar confirmado continua pendente', async () => {
    const f = fixture();
    f.api.buscarResultadosPorIds.mockResolvedValueOnce([{ ...resultadoOficial(), statusApuracao: 'EM_ANDAMENTO',
      resultado: null, golsMandante: null, golsVisitante: null, pendencia: 'PLACAR_90_MINUTOS_INDISPONIVEL' }]);
    await f.sync.evaluate();
    expect(f.state.desafio.status).toBe('EM_ANDAMENTO');
    expect(f.state.palpites.every(p => !p.apurado && p.pontos === null)).toBe(true);
  });

  it('alteracao administrativa durante consulta nao e sobrescrita', async () => {
    const f = fixture();
    f.api.buscarResultadosPorIds.mockImplementationOnce(async () => {
      f.state.desafio.status = 'CANCELADO'; return [resultadoOficial()];
    });
    await f.sync.evaluate();
    expect(f.state.desafio.status).toBe('CANCELADO');
    expect(f.tx.desafioPartida.update).not.toHaveBeenCalled();
  });

  it('concorrencia entre instancias e apuracao manual rejeita snapshots obsoletos', async () => {
    const f = fixture();
    const segunda = new DesafioSyncService(f.config as unknown as ConfigService, f.prisma, f.api as unknown as FootballDataClient, f.service);
    const resultados = await Promise.allSettled([f.sync.evaluate(), f.sync.evaluate(), segunda.evaluate(), f.service.apurar(7)]);
    for (const resultado of resultados) {
      if (resultado.status === 'rejected') expect(resultado.reason).toBeInstanceOf(ConflictException);
    }
    expect(f.state.palpites.map(p => Number(p.pontos))).toEqual([1, 0, 0]);
    expect(f.tx.desafioPartida.update).toHaveBeenCalledTimes(1);
    expect(f.tx.$queryRaw).toHaveBeenCalled();
  });

  it('rollback preserva partida e pontos se persistencia falhar', async () => {
    const f = fixture(); f.tx.desafio.update.mockRejectedValueOnce(new Error('falha'));
    await f.sync.evaluate(); expect(f.state.partidas[0].status).toBe('AGENDADA');
    expect(f.state.palpites.every(p => p.pontos === null)).toBe(true);
  });

  it.each([false, true])('usa parcial interno recente com scheduler geral=%s sem API', async geral => {
    const f = fixture();
    f.config.get.mockImplementation(key => key === 'DESAFIOS_SYNC_SCHEDULER_ENABLED' ? true : geral);
    f.prisma.futebolPartida.findMany.mockResolvedValue([interna()]);
    await f.sync.evaluate();
    expect(f.prisma.futebolPartida.findMany).toHaveBeenCalledWith({ where: { externalId: { in: [100] } },
      include: { competicao: true, timeMandante: true, timeVisitante: true } });
    expect(f.api.buscarResultadosPorIds).not.toHaveBeenCalled();
    expect(f.state.partidas[0]).toMatchObject({ status: 'EM_ANDAMENTO', golsMandante: 2, golsVisitante: 1, resultado: null });
    expect(f.state.palpites.every(p => !p.apurado && p.pontos === null)).toBe(true);
  });

  it.each([
    { ultimaAtualizacaoApi: new Date('2030-10-01T14:40:00Z') },
    { ultimaAtualizacaoApi: new Date('2030-10-01T15:01:00Z') },
    { competicao: { externalId: 999, nome: 'Outra' } },
    { timeMandante: { externalId: 999, nome: 'Outra' } },
    { timeVisitante: { externalId: 999, nome: 'Outra' } },
    { status: 'FINISHED' }, { status: 'EXTRA_TIME' }, { status: 'PENALTY_SHOOTOUT' },
    { status: 'UNKNOWN' }, { placarMandante: null },
  ])('recencia, identidade ou placar insuficiente exige fallback: %j', async overrides => {
    const f = fixture(); f.prisma.futebolPartida.findMany.mockResolvedValue([interna(overrides)]);
    await f.sync.evaluate();
    expect(f.api.buscarResultadosPorIds).toHaveBeenCalledWith([100]);
    expect(f.prisma.futebolPartida.findMany.mock.invocationCallOrder[0]).toBeLessThan(f.api.buscarResultadosPorIds.mock.invocationCallOrder[0]);
  });

  it('ausencia interna nao impede confirmacao final e resultado confirmado nao e reconsultado', async () => {
    const f = fixture(); await f.sync.evaluate(); await f.sync.evaluate();
    expect(f.state.partidas[0]).toMatchObject({ status: 'FINALIZADA', resultado: 'CASA' });
    expect(f.api.buscarResultadosPorIds).toHaveBeenCalledTimes(1);
    expect(f.prisma.futebolPartida.findMany).toHaveBeenCalledTimes(1);
  });

  it('nao sobrescreve parcial persistida depois da atualizacao do fornecedor interno', async () => {
    const f = fixture(); f.state.partidas[0].status = 'EM_ANDAMENTO';
    f.state.partidas[0].atualizadoEm = new Date('2030-10-01T14:59:30Z');
    jest.advanceTimersByTime(5 * 60_000);
    f.prisma.futebolPartida.findMany.mockResolvedValue([interna()]);
    await f.sync.evaluate(); expect(f.api.buscarResultadosPorIds).toHaveBeenCalledWith([100]);
  });

  it('FINISHED interno nao pontua quando fallback tambem nao confirma 90 minutos', async () => {
    const f = fixture(); f.prisma.futebolPartida.findMany.mockResolvedValue([interna({ status: 'FINISHED' })]);
    f.api.buscarResultadosPorIds.mockResolvedValue([{ ...resultadoOficial(), statusApuracao: 'EM_ANDAMENTO',
      resultado: null, golsMandante: null, golsVisitante: null, pendencia: 'PLACAR_90_MINUTOS_INDISPONIVEL' }]);
    await f.sync.evaluate(); expect(f.state.palpites.every(p => !p.apurado && p.pontos === null)).toBe(true);
  });

  it.each(['CANCELLED', 'POSTPONED', 'SUSPENDED', 'AWARDED'])('anula status interno recente %s sem API', async status => {
    const f = fixture(); f.prisma.futebolPartida.findMany.mockResolvedValue([interna({ status })]);
    await f.sync.evaluate(); expect(f.api.buscarResultadosPorIds).not.toHaveBeenCalled();
    expect(f.state.partidas[0]).toMatchObject({ status: 'ANULADA', golsMandante: null, golsVisitante: null });
    expect(f.state.palpites.every(p => !p.apurado && p.pontos === null)).toBe(true);
  });

  it('falha externa e backoff preservam atualizacao interna no mesmo Desafio', async () => {
    const f = fixture(); f.state.partidas.push({ ...f.state.partidas[0], id: 2, fixtureIdApiFootball: 101 });
    f.prisma.futebolPartida.findMany.mockResolvedValue([interna()]);
    f.api.buscarResultadosPorIds.mockRejectedValueOnce(new FootballDataError('erro', 'RATE_LIMIT'));
    await f.sync.evaluate();
    expect(f.api.buscarResultadosPorIds).toHaveBeenCalledWith([101]);
    expect(f.state.partidas.map(p => p.status)).toEqual(['EM_ANDAMENTO', 'AGENDADA']);
    f.prisma.futebolPartida.findMany.mockResolvedValue([interna({ placarMandante: 3 })]);
    await f.sync.evaluate();
    expect(f.state.partidas[0].golsMandante).toBe(3);
    expect(f.api.buscarResultadosPorIds).toHaveBeenCalledTimes(1);
    expect(f.state.desafio.status).toBe('EM_ANDAMENTO');
  });

  it('deduplica consulta interna e externa e processa somente lacunas', async () => {
    const f = fixture(); f.state.partidas.push({ ...f.state.partidas[0], id: 2, fixtureIdApiFootball: 101 });
    f.prisma.desafio.findMany.mockImplementationOnce(async () => Array.from({ length: 2 }, () => ({ ...f.state.desafio, partidas: f.state.partidas.map(p => ({ ...p })) })));
    f.prisma.futebolPartida.findMany.mockResolvedValue([interna()]);
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(101, 1, 1)]);
    await f.sync.evaluate();
    expect(f.prisma.futebolPartida.findMany.mock.calls[0][0].where.externalId.in).toEqual([100, 101]);
    expect(f.api.buscarResultadosPorIds).toHaveBeenCalledWith([101]);
    expect(f.tx.desafioPartida.update).toHaveBeenCalledTimes(2);
  });

  it('resultado interno repetido nao pontua e transacoes concorrentes rejeitam snapshot obsoleto', async () => {
    const f = fixture(); f.prisma.futebolPartida.findMany.mockResolvedValue([interna()]);
    const segunda = new DesafioSyncService(f.config as unknown as ConfigService, f.prisma, f.api as unknown as FootballDataClient, f.service);
    await Promise.all([f.sync.evaluate(), segunda.evaluate()]);
    expect(f.tx.desafioPartida.update).toHaveBeenCalledTimes(1);
    await f.sync.evaluate();
    expect(f.state.palpites.every(p => !p.apurado && p.pontos === null)).toBe(true);
    expect(f.api.buscarResultadosPorIds).not.toHaveBeenCalled();
  });
});
