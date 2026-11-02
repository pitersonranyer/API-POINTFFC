import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { main, expectedHash, migration } = require('../scripts/deploy-migrations.cjs');

describe('production bootstrap logging boundary', () => {
  const environment = process.env.NODE_ENV;
  const databaseUrl = process.env.DATABASE_URL;
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
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
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
  it('passes normalized TLS paths only to all CLI children, including the temporary schema', async () => {
    const original = 'mysql://fictional:secret@host/db?sslcert=ca.pem&sslidentity=identity.p12&sslaccept=strict';
    process.env.DATABASE_URL = original;
    let historyRead = 0;
    db.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
      if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
      if (sql.includes('information_schema')) return [{ n: 1 }];
      if (sql.startsWith('SELECT COUNT')) return [{ n: 0 }];
      if (sql.includes('FROM _prisma_migrations')) return historyRead++ === 0 ? [] : [
        { migration_name: '0029_point_fantasy_current_scoring', finished_at: true, rolled_back_at: null },
      ];
    });
    db.$executeRawUnsafe = jest.fn(async () => 1);
    try {
      await main();
      const calls = (execFileSync as jest.Mock).mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls.map(call => call[1].slice(1, 3))).toEqual([
        ['migrate', 'deploy'], ['db', 'execute'], ['migrate', 'deploy'],
      ]);
      for (const call of calls) {
        const childEnvironment = call[2].env;
        const url = new URL(childEnvironment.DATABASE_URL);
        expect(url.searchParams.get('sslcert')).toBe(path.resolve('prisma/ca.pem'));
        expect(url.searchParams.get('sslidentity')).toBe(path.resolve('prisma/identity.p12'));
        expect(url.searchParams.get('sslaccept')).toBe('strict');
        expect(childEnvironment).not.toBe(process.env);
      }
      expect(process.env.DATABASE_URL).toBe(original);
      expect(PrismaClient).toHaveBeenCalledWith();
      expect(JSON.stringify(events)).not.toMatch(/secret|mysql:|ca\.pem|identity\.p12/);
    } finally {
      const args = (execFileSync as jest.Mock).mock.calls[0]?.[1];
      if (args) {
        const directory = path.resolve(path.dirname(args.at(-1)));
        if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('point-ffc-bootstrap-')) {
          throw new Error('UNEXPECTED_TEST_CLEANUP_PATH');
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
