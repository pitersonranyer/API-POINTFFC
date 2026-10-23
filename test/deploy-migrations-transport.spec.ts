import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deploy, transport, expectedHash, migration } = require('../scripts/deploy-migrations.cjs');

describe('automatic bootstrap DELIMITER compatibility', () => {
  let db: any, run: jest.Mock, history: any[], failed: boolean, nonempty: boolean;
  const completed = (name: string) => ({ migration_name: name, checksum: expectedHash, finished_at: new Date(), rolled_back_at: null });
  beforeEach(() => {
    history = []; failed = false; nonempty = false;
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
  const apply = () => deploy({ db, run, makeRestrictedSchema: () => 'restricted-schema' });
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
