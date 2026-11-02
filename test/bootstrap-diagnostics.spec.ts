import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { main, expectedHash, migration } = require('../scripts/deploy-migrations.cjs');

describe('production bootstrap logging boundary', () => {
  const environment = process.env.NODE_ENV;
  let events: any[], db: any, output: jest.SpyInstance;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    events = [];
    output = jest.spyOn(console, 'log').mockImplementation(line => events.push(JSON.parse(line)));
    db = {
      $transaction: jest.fn(async action => action(db)),
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
        if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
        if (sql.includes('information_schema')) return [{ n: 1 }];
        return [{ migration_name: migration, checksum: expectedHash, finished_at: true, rolled_back_at: null }];
      }),
      $disconnect: jest.fn(async () => undefined),
    };
    (PrismaClient as jest.Mock).mockImplementation(() => db);
  });
  afterEach(() => {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    output.mockRestore();
    jest.resetAllMocks();
  });
  it('logs startup, CLI completion and shutdown without forwarding raw CLI output', async () => {
    (execFileSync as jest.Mock).mockReturnValue(Buffer.from('secret CLI output'));
    await main();
    expect(events[0]).toMatchObject({ stage: 'bootstrap', result: 'started' });
    expect(events.at(-1)).toMatchObject({ stage: 'bootstrap', result: 'succeeded' });
    expect(events).toContainEqual(expect.objectContaining({ stage: 'client_disconnect', result: 'succeeded' }));
    expect(execFileSync).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    }));
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
  });
  it('keeps P1001 and the failing stage while sanitizing subprocess errors through shutdown', async () => {
    const error = Object.assign(new Error('mysql://secret:password@private/db'), {
      stderr: Buffer.from('Error: P1001 certificate-secret'), stdout: 'secret',
    });
    (execFileSync as jest.Mock).mockImplementation(() => { throw error; });
    await expect(main()).rejects.toBe(error);
    expect(events).toContainEqual(expect.objectContaining({ stage: 'cli_post_0030', result: 'failed', error_code: 'P1001' }));
    expect(events.at(-1)).toMatchObject({ stage: 'bootstrap', result: 'failed', error_code: 'P1001' });
    expect(JSON.stringify(events)).not.toMatch(/secret|password|private|mysql:/);
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
  });
  it('records a production guard failure once without constructing a client', async () => {
    process.env.NODE_ENV = 'test';
    await expect(main()).rejects.toThrow('AUTOMATIC_PRODUCTION_BOOTSTRAP_ONLY');
    expect(events.filter(e => e.result === 'failed')).toHaveLength(1);
    expect(PrismaClient).not.toHaveBeenCalled();
  });
});
