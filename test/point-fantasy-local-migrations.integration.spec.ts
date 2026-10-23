import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { WriterAdmissionService } from '../src/point-fantasy/observation/writer-admission.service';
import { PrismaService } from '../src/prisma/prisma.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const x = require('../scripts/point-fantasy-local-migrations.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfill } = require('../scripts/point-fantasy-scoring-backfill.cjs');
const enabled = process.env.POINT_FANTASY_LOCAL_PLAN && process.env.POINT_FANTASY_LOCAL_TEST_URL;
(enabled ? describe : describe.skip)('restricted 0029/0030 executor on restored local backup', () => {
  jest.setTimeout(900000);
  const plan = enabled ? JSON.parse(readFileSync(process.env.POINT_FANTASY_LOCAL_PLAN!, 'utf8')) : null;
  let admin: PrismaClient, counter = Date.now();
  const clients: PrismaClient[] = [];
  beforeAll(() => { x.destination(process.env.POINT_FANTASY_LOCAL_TEST_URL, true); admin = new PrismaClient({ datasources: { db: { url: process.env.POINT_FANTASY_LOCAL_TEST_URL } } }); });
  afterAll(async () => { await Promise.all(clients.map(c => c.$disconnect())); await admin?.$disconnect(); });
  async function restored() {
    const url = new URL(process.env.POINT_FANTASY_LOCAL_TEST_URL!); url.pathname = '/point_fantasy_observation_3b2_test_' + (++counter);
    x.destination(url.toString(), true);
    await admin.$executeRawUnsafe('CREATE DATABASE `' + url.pathname.slice(1) + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    x.sql(url.toString(), readFileSync(plan.backup.file, 'utf8'));
    const db = new PrismaClient({ datasources: { db: { url: url.toString() } } }); clients.push(db);
    return { db, url: url.toString(), run: (extra = {}) => x.apply({ url: url.toString(), plan, isolated: true, ...extra }) };
  }
  it('refuses principal without explicit bound approval and refuses changed migration manifest', async () => {
    await expect(x.apply({ url: 'mysql://unused:unused@127.0.0.1:3306/fantasy_point_do_jogador', plan })).rejects.toThrow('EXPLICIT_BOUND_APPROVAL_REQUIRED');
    const fixture = await restored();
    await expect(x.apply({ url: fixture.url, plan: { ...plan, files: {} }, isolated: true })).rejects.toThrow('PINNED_ARTIFACT_CHANGED');
    expect(await x.history(fixture.db)).toHaveLength(plan.history.length);
  });
  it('applies only exact 0029 then 0030, preserves data/history and is idempotent', async () => {
    const f = await restored(); await f.run(); const first = await x.history(f.db);
    expect(first).toHaveLength(plan.history.length + 2);
    expect(x.stable(first.filter((r: any) => !x.names.includes(r.migration_name)))).toBe(x.stable(plan.history));
    for (const [i, name] of x.names.entries()) { const row = first.find((r: any) => r.migration_name === name); expect(row.checksum).toBe(x.pinned[i]); expect(row.finished_at).toBeTruthy(); expect(row.rolled_back_at).toBeNull(); }
    expect(first.find((r: any) => r.migration_name === x.names[0]).finished_at.getTime()).toBeLessThanOrEqual(first.find((r: any) => r.migration_name === x.names[1]).started_at.getTime());
    await f.run(); expect(await x.history(f.db)).toEqual(first);
    expect((await x.dataManifest(f.db, plan.data.columns)).data).toEqual(plan.data.data);
  });
  it.each(['0029_point_fantasy_current_scoring:1', '0030_point_fantasy_writer_admission:2', '0030_point_fantasy_writer_admission:23'])('records interrupted DDL and recovers exact remaining statements: %s', async boundary => {
    const f = await restored(); await expect(f.run({ interruptAfter: boundary })).rejects.toThrow('FIXTURE_DDL_INTERRUPTION');
    const failedName = boundary.split(':')[0];
    const failed = (await x.history(f.db)).find((r: any) => r.migration_name === failedName && !r.finished_at && !r.rolled_back_at);
    expect(failed).toBeTruthy(); expect(failed.logs).toContain('FIXTURE_DDL_INTERRUPTION');
    await expect(f.run()).rejects.toThrow('RECOVERY_REQUIRED');
    await f.run({ recover: true });
    const rows = await x.history(f.db), recovered = rows.find((r: any) => r.id === failed.id);
    expect(recovered.finished_at).toBeNull(); expect(recovered.rolled_back_at).toBeTruthy(); expect(recovered.logs).toContain('FIXTURE_DDL_INTERRUPTION');
    for (const name of x.names) expect(rows.filter((r: any) => r.migration_name === name && r.finished_at && !r.rolled_back_at)).toHaveLength(1);
    expect((await x.dataManifest(f.db, plan.data.columns)).data).toEqual(plan.data.data);
  });
  it('fails closed for a live writer, data drift and an unknown partial DDL state', async () => {
    const f = await restored();
    await f.db.$executeRawUnsafe('UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=UUID(),LOCK_ATE=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND) WHERE TEMPORADA=2026 AND RODADA=31');
    await expect(f.run()).rejects.toThrow('WRITERS_NOT_DRAINED');
    await f.db.$executeRawUnsafe('UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=NULL,LOCK_ATE=NULL WHERE TEMPORADA=2026 AND RODADA=31');
    await f.db.$executeRawUnsafe('UPDATE FANTASY_APURACAO_RODADA SET FENCE=FENCE+1 WHERE TEMPORADA=2026 AND RODADA=31');
    await expect(f.run()).rejects.toThrow('BASE_DATA_CHANGED_NEW_PREPARATION_REQUIRED');
    await f.db.$executeRawUnsafe('UPDATE FANTASY_APURACAO_RODADA SET FENCE=FENCE-1 WHERE TEMPORADA=2026 AND RODADA=31');
    await expect(f.run({ interruptAfter: x.names[0] + ':1' })).rejects.toThrow('FIXTURE_DDL_INTERRUPTION');
    x.sql(f.url, 'CREATE TABLE fixture_unexpected (id INT);');
    await expect(f.run({ recover: true })).rejects.toThrow('UNKNOWN_DDL_BOUNDARY');
  });
  it('cuts legacy, backfills the restored 275 athletes exactly and enables ATUAL durably', async () => {
    const f = await restored(); await f.run();
    const service = new WriterAdmissionService(f.db as PrismaService, f.url);
    async function request(target: 'LEGADO' | 'BLOQUEADO' | 'ATUAL') {
      const r = await f.db.fantasyApuracaoRodada.findUniqueOrThrow({ where: { temporada_rodada: { temporada: 2026, rodada: 31 } } });
      const c = await f.db.fantasyEscritaControle.findUnique({ where: { temporada_rodada: { temporada: 2026, rodada: 31 } } });
      return { season: 2026, round: 31, target, operationId: randomUUID(), operator: 'isolated-rehearsal', reason: 'restored real snapshot cutover', expectedMode: c?.modo ?? null, expectedGeneration: c?.geracao ?? 0n, expectedRevision: r.revisaoAtual, expectedHash: r.hashConteudoAtual, expectedFence: r.fence };
    }
    await service.initialize(await request('LEGADO')); await service.transition(await request('BLOQUEADO'));
    await expect(service.transition(await request('ATUAL'))).rejects.toThrow('ADMISSION_NOT_QUIESCENT_OR_BACKFILLED');
    const first = await backfill(f.url, 2026, 31); expect(Number(first.total)).toBe(275); expect(Number(first.tecnicos)).toBe(20);
    const second = await backfill(f.url, 2026, 31); expect(second.reused).toBe(true); expect(second.soma).toBe(first.soma);
    await service.transition(await request('ATUAL'));
    await expect(f.db.$executeRawUnsafe('UPDATE FANTASY_APURACAO_RODADA SET ULTIMA_VERSAO_SNAPSHOT=ULTIMA_VERSAO_SNAPSHOT+1 WHERE TEMPORADA=2026 AND RODADA=31')).rejects.toThrow();
    await expect(service.transition(await request('LEGADO'))).rejects.toThrow('ADMISSION_TRANSITION_INVALID');
    expect(await f.db.fantasyPontuacaoAtletaSnapshot.count()).toBe(275);
    expect(x.stable(x.verifyBase(await x.history(f.db), plan.files))).toBe(x.stable(plan.history));
  });
});
