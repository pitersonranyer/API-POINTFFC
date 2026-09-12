import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FutebolSyncService } from '../src/futebol/futebol-sync.service';
import { FutebolSchedulerService } from '../src/futebol/futebol-scheduler.service';
import { futebolSyncDecision } from '../src/futebol/futebol-sync-policy';

const date = (value: string) => new Date(value);
const match = (value: string, status = 'TIMED') => ({ dataHoraUtc: date(value), status });
const future = match('2026-09-20T22:00:00Z');
describe('Futebol scheduling policy (America/Sao_Paulo)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  function decision(now: string, last: string | null, matches = [future]) {
    jest.setSystemTime(date(now));
    return futebolSyncDecision(new Date(), last ? date(last) : null, matches).due;
  }
  it('loads empty data or data without success history', () => {
    expect(decision('2026-09-11T08:00:00Z', null, [])).toBe(true);
    expect(decision('2026-09-11T08:00:00Z', null)).toBe(true);
  });
  it.each([
    ['2026-09-11T08:55:00Z', '2026-09-10T21:00:00Z', false],
    ['2026-09-11T09:00:00Z', '2026-09-10T21:00:00Z', true],
    ['2026-09-11T20:55:00Z', '2026-09-11T09:00:00Z', false],
    ['2026-09-11T21:00:00Z', '2026-09-11T09:00:00Z', true],
    ['2026-09-11T21:05:00Z', '2026-09-11T21:00:00Z', false],
    ['2026-09-12T01:00:00Z', '2026-09-11T21:00:00Z', false],
    ['2026-09-12T08:00:00Z', '2026-09-11T09:00:00Z', true],
  ])('quiet-day slots/cold-start catchup %s', (now, last, expected) => expect(decision(now, last)).toBe(expected));
  it.each([
    ['TIMED', '2026-09-11T23:00:00Z', 60],
    ['SCHEDULED', '2026-09-11T19:00:00Z', 10],
    ['IN_PLAY', '2026-09-11T17:00:00Z', 5],
    ['PAUSED', '2026-09-11T17:00:00Z', 5],
    ['TIMED', '2026-09-11T17:00:00Z', 5],
    ['SCHEDULED', '2026-09-11T15:05:00Z', 5],
  ])('%s interval %s: %s minutes', (status, kickoff, minutes) => {
    const now = '2026-09-11T18:00:00Z';
    const matches = [match(kickoff, status)];
    expect(decision(now, new Date(date(now).getTime() - minutes * 60_000 + 5 * 60_000).toISOString(), matches)).toBe(false);
    expect(decision(now, new Date(date(now).getTime() - minutes * 60_000).toISOString(), matches)).toBe(true);
  });
  it('handles near/live matches across local midnight', () => {
    expect(decision('2026-09-12T02:30:00Z', '2026-09-12T02:20:00Z', [match('2026-09-12T03:15:00Z')])).toBe(true);
    expect(decision('2026-09-12T03:30:00Z', '2026-09-12T03:25:00Z', [match('2026-09-12T02:00:00Z')])).toBe(true);
  });
  it('does not skip a cron window because sync started milliseconds after the tick', () => {
    const matches = [match('2026-09-11T17:00:00Z', 'IN_PLAY')];
    expect(decision('2026-09-11T17:05:00.005Z', '2026-09-11T17:00:00.150Z', matches)).toBe(true);
    expect(decision('2026-09-11T17:05:59Z', '2026-09-11T17:05:00.150Z', matches)).toBe(false);
  });
  it.each(['TIMED', 'SCHEDULED', 'FINISHED'])('reconciles after 3h once, including stale %s', status => {
    const matches = [match('2026-09-11T22:00:00Z', status)];
    expect(decision('2026-09-12T01:00:00Z', '2026-09-12T00:55:00Z', matches)).toBe(true);
    expect(decision('2026-09-12T01:05:00Z', '2026-09-12T01:00:00Z', matches)).toBe(false);
    expect(decision('2026-09-12T08:00:00Z', '2026-09-12T01:00:00Z', matches)).toBe(false);
  });
});

describe('FutebolSchedulerService', () => {
  function setup(flag: unknown = true, last: Date | null = null) {
    const prisma = { futebolCompeticao: { findUnique: jest.fn().mockResolvedValue({ id: 1, temporadaAtual: 2026, ultimoSyncEm: last }) },
      futebolPartida: { findMany: jest.fn().mockResolvedValue([future]) } };
    const sync = { syncBrasileirao: jest.fn().mockResolvedValue({ clubesProcessados: 20, partidasPersistidas: 380 }) };
    const config = { get: jest.fn(() => flag) };
    const service = new FutebolSchedulerService(config as unknown as ConfigService,
      prisma as unknown as PrismaService, sync as unknown as FutebolSyncService);
    return { prisma, sync, service, config };
  }
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(date('2026-09-11T15:00:00Z')); });
  afterEach(() => jest.useRealTimers());
  it.each([false, undefined, 'false'])('disabled %s does not query DB or sync on startup/tick', async flag => {
    const { service, prisma, sync, config } = setup();
    config.get.mockReturnValue(flag);
    service.onApplicationBootstrap(); await service.evaluate();
    expect(prisma.futebolCompeticao.findUnique).not.toHaveBeenCalled(); expect(sync.syncBrasileirao).not.toHaveBeenCalled();
  });
  it.each([null, { id: 1, temporadaAtual: 2026, ultimoSyncEm: null }])('initial load when BSA/season is empty', async competition => {
    const { service, prisma, sync } = setup('true');
    prisma.futebolCompeticao.findUnique.mockResolvedValue(competition); prisma.futebolPartida.findMany.mockResolvedValue([]);
    service.onApplicationBootstrap(); await jest.advanceTimersByTimeAsync(0);
    expect(sync.syncBrasileirao).toHaveBeenCalledTimes(1);
  });
  it.each([['2026-09-11T09:00:00Z', 0], ['2026-09-10T09:00:00Z', 1]])('startup freshness %s', async (last, calls) => {
    const { service, sync, prisma } = setup(true, date(last));
    service.onApplicationBootstrap(); await jest.advanceTimersByTimeAsync(0);
    expect(sync.syncBrasileirao).toHaveBeenCalledTimes(calls);
    expect(prisma.futebolPartida.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { competicaoId: 1, temporada: 2026 } }));
  });
  it('locks startup and overlapping scheduler executions before DB lookup', async () => {
    const { service, sync, prisma } = setup();
    let release!: () => void;
    sync.syncBrasileirao.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    service.onApplicationBootstrap(); await jest.advanceTimersByTimeAsync(0);
    await Promise.all([service.evaluate(), service.evaluate()]);
    expect(prisma.futebolCompeticao.findUnique).toHaveBeenCalledTimes(1);
    expect(sync.syncBrasileirao).toHaveBeenCalledTimes(1);
    release(); await jest.advanceTimersByTimeAsync(0);
  });
  it('startup failure is contained, unlocks and retries with cooldown', async () => {
    const { service, sync } = setup();
    sync.syncBrasileirao.mockRejectedValueOnce(new Error('provider failed'));
    expect(() => service.onApplicationBootstrap()).not.toThrow(); await jest.advanceTimersByTimeAsync(0);
    await service.evaluate(); expect(sync.syncBrasileirao).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60 * 60_000); await service.evaluate();
    expect(sync.syncBrasileirao).toHaveBeenCalledTimes(2);
  });
  it('contains DB failures and releases lock', async () => {
    const { service, prisma, sync } = setup();
    prisma.futebolCompeticao.findUnique.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(service.evaluate()).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(5 * 60_000); await service.evaluate();
    expect(sync.syncBrasileirao).toHaveBeenCalledTimes(1);
  });
  it('reports missing migrations without exposing raw database errors', async () => {
    const { service, prisma } = setup();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      prisma.futebolCompeticao.findUnique.mockRejectedValueOnce(
        Object.assign(new Error('mysql://private-credentials'), { code: 'P2022' }),
      );
      await service.evaluate();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('0016_futebol_ultimo_sync'));
      expect(warn.mock.calls.flat().join(' ')).not.toContain('private-credentials');
    } finally { warn.mockRestore(); }
  });
});
