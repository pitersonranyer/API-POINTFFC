import { execFileSync } from 'node:child_process';
import { deployMigrations } from '../src/prisma/deploy-migrations';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));

describe('deployMigrations', () => {
  const originalEnvironment = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
    jest.resetAllMocks();
  });

  it('aplica as migrations em producao usando o Prisma instalado', () => {
    process.env.NODE_ENV = 'production';
    deployMigrations();
    expect(execFileSync).toHaveBeenCalledWith(process.execPath, [
      require.resolve('prisma'), 'migrate', 'deploy', '--schema',
      expect.stringMatching(/prisma[/\\]schema\.prisma$/),
    ], { stdio: 'inherit', env: process.env });
  });

  it('nao aplica migrations automaticamente em desenvolvimento', () => {
    process.env.NODE_ENV = 'development';
    deployMigrations();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('propaga falhas para impedir a inicializacao com banco desatualizado', () => {
    process.env.NODE_ENV = 'production';
    jest.mocked(execFileSync).mockImplementation(() => { throw new Error('Migration falhou'); });
    expect(() => deployMigrations()).toThrow('Migration falhou');
  });
});
