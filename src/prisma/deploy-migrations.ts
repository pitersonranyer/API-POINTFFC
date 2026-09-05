import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export function deployMigrations(): void {
  if (process.env.NODE_ENV !== 'production') return;

  execFileSync(process.execPath, [
    require.resolve('prisma'),
    'migrate',
    'deploy',
    '--schema',
    resolve(__dirname, '../../prisma/schema.prisma'),
  ], { stdio: 'inherit', env: process.env });
}
