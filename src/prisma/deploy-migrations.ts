import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export function deployMigrations(): void {
  if (process.env.NODE_ENV !== 'production') return;

  execFileSync(process.execPath, [
    resolve(__dirname, '../../scripts/deploy-migrations.cjs'),
  ], { stdio: 'inherit', env: process.env });
}
