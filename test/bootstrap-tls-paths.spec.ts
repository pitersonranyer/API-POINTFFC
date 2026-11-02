import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cliEnvironment, restrictedSchema } = require('../scripts/deploy-migrations.cjs');

describe('bootstrap CLI TLS file paths', () => {
  let root: string, schema: string;
  const base = 'mysql://user:p%40ss@host.example:25060/database';
  const value = (env: any, key: string) => new URL(env.DATABASE_URL).searchParams.get(key);
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'point-ffc-tls-test-'));
    mkdirSync(path.join(root, 'prisma'));
    schema = path.join(root, 'prisma', 'schema.prisma');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    // Remove only this test's explicitly named temporary workspace.
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('point-ffc-tls-test-')) {
      throw new Error('UNEXPECTED_TEST_CLEANUP_PATH');
    }
    rmSync(target, { recursive: true, force: true });
  });
  it('anchors both relative file parameters to the original schema directory', () => {
    const env = { DATABASE_URL: base + '?sslcert=ca.pem&sslidentity=../identity.p12&sslaccept=strict' };
    const result = cliEnvironment(env, schema);
    expect(value(result, 'sslcert')).toBe(path.join(root, 'prisma', 'ca.pem'));
    expect(value(result, 'sslidentity')).toBe(path.join(root, 'identity.p12'));
    expect(value(result, 'sslaccept')).toBe('strict');
    expect(env.DATABASE_URL).toBe(base + '?sslcert=ca.pem&sslidentity=../identity.p12&sslaccept=strict');
    expect(result).not.toBe(env);
  });
  it('preserves absolute certificate paths and their original URL escaping byte for byte', () => {
    const cert = encodeURIComponent(path.join(root, 'absolute ca.pem'));
    const env = { DATABASE_URL: base + '?sslcert=' + cert + '&sslidentity=' + cert + '&sslaccept=strict' };
    expect(cliEnvironment(env, schema)).toEqual(env);
  });
  it.each([undefined, base, base + '?sslaccept=strict&connect_timeout=8', base + '?sslcert=&sslidentity='])
  ('preserves URLs without certificate file values: %s', url => {
    const env = url === undefined ? { OTHER: 'retained' } : { DATABASE_URL: url, OTHER: 'retained' };
    expect(cliEnvironment(env, schema)).toEqual(env);
  });
  it('does not silently replace, create or ignore a nonexistent certificate', () => {
    const env = cliEnvironment({ DATABASE_URL: base + '?sslcert=missing.pem&sslaccept=strict' }, schema);
    const cert = value(env, 'sslcert')!;
    expect(cert).toBe(path.join(root, 'prisma', 'missing.pem'));
    expect(() => readFileSync(cert)).toThrow();
    expect(value(env, 'sslaccept')).toBe('strict');
  });
  it.each(['CA com espaços # + % & = ç.pem', 'identity + senha.p12'])('round trips special file characters: %s', filename => {
    const cert = path.join(root, 'prisma', filename);
    writeFileSync(cert, 'synthetic fixture');
    const encoded = encodeURIComponent(filename).replace(/%20/g, '+');
    const result = cliEnvironment({ DATABASE_URL: base + '?sslcert=' + encoded + '&sslidentity=' + encoded }, schema);
    expect(value(result, 'sslcert')).toBe(cert);
    expect(value(result, 'sslidentity')).toBe(cert);
    expect(readFileSync(value(result, 'sslcert')!, 'utf8')).toBe('synthetic fixture');
  });
  it('preserves every unrelated URL byte, duplicate option and validation setting', () => {
    const prefix = base + '?socket_timeout=010&sslpassword=a%2bb+c%26d&';
    const suffix = '&sslaccept=strict&x=%2f&x=second&connection_limit=4#retained';
    const env = { DATABASE_URL: prefix + 'sslcert=ca.pem' + suffix, OTHER: 'untouched' };
    const result = cliEnvironment(env, schema);
    expect(result.DATABASE_URL).toBe(prefix + 'sslcert=' + encodeURIComponent(path.join(root, 'prisma', 'ca.pem')) + suffix);
    expect(result.OTHER).toBe('untouched');
  });
  it('keeps duplicate TLS parameters without collapsing or changing their order', () => {
    const result = cliEnvironment({ DATABASE_URL: base + '?sslcert=a.pem&sslcert=b.pem&sslidentity=c.p12' }, schema);
    expect(new URL(result.DATABASE_URL).searchParams.getAll('sslcert')).toEqual([
      path.join(root, 'prisma', 'a.pem'), path.join(root, 'prisma', 'b.pem'),
    ]);
  });
  it('eliminates the missing-file condition behind the reproduced P1001 in a temporary schema subprocess', () => {
    const cert = path.join(root, 'prisma', 'ca.pem');
    const identity = path.join(root, 'prisma', 'identity.p12');
    writeFileSync(cert, 'synthetic CA');
    writeFileSync(identity, 'synthetic identity');
    jest.spyOn(os, 'tmpdir').mockReturnValue(root);
    const temporarySchema = restrictedSchema(process.cwd());
    const env = { ...process.env, DATABASE_URL: base + '?sslcert=ca.pem&sslidentity=identity.p12&sslaccept=strict' };
    // Model only file resolution in a CLI subprocess. No Prisma command or DB access.
    const check = `const fs=require('fs'),p=require('path'),u=new URL(process.env.DATABASE_URL);
      for(const key of ['sslcert','sslidentity']) {
        const file=p.resolve(p.dirname(process.argv[1]),u.searchParams.get(key));
        if(!fs.existsSync(file)) { process.stdout.write('TLS_FILE_MISSING'); process.exit(2); }
        fs.readFileSync(file);
      }
      process.stdout.write('TLS_FILES_READABLE');`;
    const run = (environment: any, source: string) => execFileSync(process.execPath, ['-e', check, source], {
      env: environment, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    });
    expect(run(env, schema)).toBe('TLS_FILES_READABLE');
    expect(() => run(env, temporarySchema)).toThrow();
    const corrected = cliEnvironment(env, schema);
    expect(run(corrected, temporarySchema)).toBe('TLS_FILES_READABLE');
    expect(run(corrected, schema)).toBe('TLS_FILES_READABLE');
    expect(value(corrected, 'sslaccept')).toBe('strict');
    expect(value(env, 'sslcert')).toBe('ca.pem');
    expect(readFileSync(temporarySchema)).toEqual(readFileSync('prisma/schema.prisma'));
    jest.restoreAllMocks();
  });
});
