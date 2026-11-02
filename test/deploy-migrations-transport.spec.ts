import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deploy, transport, expectedHash, migration } = require('../scripts/deploy-migrations.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { diagnostics, errorMetadata } = require('../scripts/bootstrap-diagnostics.cjs');

describe('automatic bootstrap DELIMITER compatibility', () => {
  let db: any, run: jest.Mock, history: any[], failed: boolean, nonempty: boolean;
  let events: any[], log: any;
  const completed = (name: string) => ({ migration_name: name, checksum: expectedHash, finished_at: new Date(), rolled_back_at: null });
  beforeEach(() => {
    history = []; failed = false; nonempty = false;
    events = [];
    log = diagnostics((line: string) => events.push(JSON.parse(line)));
    db = {
      $transaction: jest.fn(async action => action(db)),
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
        if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
        if (sql.includes('information_schema.TABLES')) return [{ n: 1 }];
        if (sql.includes('FROM _prisma_migrations')) return history;
        if (sql.startsWith('SELECT COUNT')) return [{ n: nonempty ? 1 : 0 }];
        throw Error('Unexpected read');
      }),
      $executeRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.startsWith('INSERT')) history.push({ migration_name: migration, checksum: expectedHash, finished_at: null, rolled_back_at: null });
        if (sql.includes('finished_at=UTC_TIMESTAMP')) history[history.length - 1].finished_at = new Date();
        return 1;
      }),
    };
    run = jest.fn((args: string[]) => {
      if (args.includes('restricted-schema')) history = [completed('0029_point_fantasy_current_scoring')];
      if (args[0] === 'db' && failed) throw Error('CLI_FAILED');
    });
  });
  const apply = () => deploy({ db, run, log, makeRestrictedSchema: () => 'restricted-schema' });
  it('records the ordered stages without changing the migration calls', async () => {
    await apply();
    expect(events.filter(e => e.result === 'succeeded').map(e => e.stage)).toEqual([
      'artifact_validation', 'client_connection', 'lock_acquire', 'migration_history',
      'temporary_schema', 'cli_through_0029', 'migration_boundary', 'observation_guard',
      'migration_0030_history_start', 'cli_transport_0030', 'migration_0030_verify',
      'migration_0030_history_complete', 'cli_post_0030', 'lock_release',
    ]);
    expect(events.every(e => e.duration_ms >= 0)).toBe(true);
  });
  it.each([0, 1, 2])('identifies CLI failure %i and suppresses all raw error fields', async index => {
    const original = run.getMockImplementation()!;
    let call = 0;
    const error = Object.assign(new Error('mysql://user:secret@host/db certificate-secret'), {
      stderr: Buffer.from('Error: P1001 mysql://user:secret@host/db certificate-secret'),
      stdout: 'secret-output', stack: 'secret-stack', name: 'secret-type', code: 'secret-code',
    });
    run.mockImplementation((...args: any[]) => {
      if (call++ === index) throw error;
      return original(...args);
    });
    await expect(apply()).rejects.toBe(error);
    const event = events.find(e => e.result === 'failed');
    expect(event).toMatchObject({ stage: ['cli_through_0029', 'cli_transport_0030', 'cli_post_0030'][index],
      error_code: 'P1001', error_type: 'UnknownError', previous_stage: { result: 'succeeded' } });
    expect(JSON.stringify(events)).not.toMatch(/secret|mysql:|certificate|restricted-schema/);
    expect(events.at(-1)).toMatchObject({ stage: 'lock_release', result: 'succeeded' });
  });
  it('reports initial connection failure without acquiring or releasing a lock', async () => {
    const error = Object.assign(new Error('secret'), { errorCode: 'P1001', name: 'PrismaClientInitializationError' });
    db.$transaction.mockRejectedValueOnce(error);
    await expect(apply()).rejects.toBe(error);
    expect(events.at(-1)).toMatchObject({ stage: 'client_connection', result: 'failed', error_code: 'P1001',
      error_type: 'PrismaClientInitializationError', previous_stage: { stage: 'artifact_validation', result: 'succeeded' } });
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('reports temporary schema failure and still releases the lock', async () => {
    await expect(deploy({ db, run, log, makeRestrictedSchema: () => { throw new Error('secret'); } })).rejects.toThrow('secret');
    expect(events.find(e => e.result === 'failed')).toMatchObject({ stage: 'temporary_schema', error_code: 'UNKNOWN' });
    expect(run).not.toHaveBeenCalled();
    expect(events.at(-1).stage).toBe('lock_release');
  });
  it('sanitizes unknown errors and does not let a logging failure affect execution', async () => {
    expect(errorMetadata({ code: 'secret', name: 'secret', message: 'secret', meta: { password: 'secret' } }))
      .toEqual({ error_code: 'UNKNOWN', error_type: 'UnknownError' });
    expect(errorMetadata(null)).toEqual({ error_code: 'UNKNOWN', error_type: 'UnknownError' });
    expect(errorMetadata({ code: 'ENOTFOUND', name: 'Error', message: 'secret host' }))
      .toEqual({ error_code: 'ENOTFOUND', error_type: 'Error' });
    log = diagnostics(() => { throw new Error('logger unavailable'); });
    await expect(apply()).resolves.toBeUndefined();
  });
  it('records elapsed time and the previous stage result on failure', async () => {
    let clock = 10;
    const local = diagnostics((line: string) => events.push(JSON.parse(line)), () => clock);
    local.sync('first', () => { clock = 25; });
    await expect(local.step('second', async () => { clock = 60; throw new Error('secret'); })).rejects.toThrow('secret');
    expect(events.at(-1)).toMatchObject({ stage: 'second', result: 'failed', duration_ms: 35,
      previous_stage: { stage: 'first', result: 'succeeded' } });
  });
  it.each(['lock_acquire', 'migration_history', 'lock_release'])('identifies %s failures', async stage => {
    const original = db.$queryRawUnsafe.getMockImplementation();
    db.$queryRawUnsafe.mockImplementation((sql: string) => {
      const target = stage === 'lock_acquire' ? 'GET_LOCK' : stage === 'lock_release' ? 'RELEASE_LOCK' : 'information_schema';
      if (sql.includes(target)) throw Object.assign(new Error('secret'), { code: 'P1001' });
      return original(sql);
    });
    await expect(apply()).rejects.toThrow('secret');
    expect(events.find(e => e.result === 'failed')).toMatchObject({ stage, error_code: 'P1001' });
    expect(JSON.stringify(events)).not.toContain('secret');
  });
  it('pins the original checksum and transforms only CLI separator lines', () => {
    const bytes = readFileSync('prisma/migrations/0030_point_fantasy_writer_admission/migration.sql');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
    const sql = transport(bytes.toString());
    expect(sql).not.toMatch(/^DELIMITER/m);
    expect(sql).not.toMatch(/\$\$$/m);
    expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(18);
    expect(sql.match(/CREATE PROCEDURE/g)).toHaveLength(3);
    expect(transport("DELIMITER $$\nSELECT '$$ literal';\nEND$$\nDELIMITER ;\n")).toContain("SELECT '$$ literal';\nEND;");
  });
  it('uses original earlier migrations, pinned transport, guard verification and then the full chain', async () => {
    await apply();
    expect(run.mock.calls.map(c => c[0].slice(0, 2))).toEqual([['migrate', 'deploy'], ['db', 'execute'], ['migrate', 'deploy']]);
    expect(run.mock.calls[1][1]).not.toMatch(/^DELIMITER/m);
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO _prisma_migrations'),
      expect.any(String), expectedHash, migration, expect.any(String));
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith('CALL FANTASY_VERIFY_ADMISSION()');
    expect(history.find(r => r.migration_name === migration).finished_at).toBeInstanceOf(Date);
  });
  it('leaves a committed failure marker and prevents blind retry after partial DDL', async () => {
    failed = true;
    await expect(apply()).rejects.toThrow('CLI_FAILED');
    expect(history.find(r => r.migration_name === migration).finished_at).toBeNull();
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('SET logs=?'), expect.stringContaining('partial DDL possible'), expect.any(String));
    run.mockClear();
    await expect(apply()).rejects.toThrow('BOOTSTRAP_FAILED_MIGRATION_REQUIRES_REVIEW');
    expect(run).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('RELEASE_LOCK'));
  });
  it('does not replay an applied migration or touch its history', async () => {
    history = [completed(migration)];
    await apply();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].slice(0, 2)).toEqual(['migrate', 'deploy']);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('blocks checksum conflicts before invoking migrations', async () => {
    history = [{ ...completed(migration), checksum: 'wrong' }];
    await expect(apply()).rejects.toThrow('BOOTSTRAP_0030_HISTORY_MISMATCH');
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses automatic cutover of observation data', async () => {
    nonempty = true;
    await expect(apply()).rejects.toThrow('BOOTSTRAP_OBSERVATION_DATA_REQUIRES_REVIEW');
    expect(run).toHaveBeenCalledTimes(1);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('does not invoke migrations if another bootstrap holds the lock', async () => {
    db.$queryRawUnsafe.mockResolvedValueOnce([{ acquired: 0 }]);
    await expect(apply()).rejects.toThrow('BOOTSTRAP_MIGRATIONS_BUSY');
    expect(run).not.toHaveBeenCalled();
  });
});
