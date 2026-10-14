import { readFileSync } from 'fs';
import { join } from 'path';

describe('Telegram link migration', () => {
  const migration = readFileSync(
    join(__dirname, '../prisma/migrations/0021_telegram_account_link/migration.sql'),
    'utf8',
  );

  it('enforces one active link per POINT FFC user and Telegram identity', () => {
    expect(migration).toContain('UNIQUE INDEX `TELEGRAM_ACCOUNT_LINK_usuario_id_key` (`usuario_id`)');
    expect(migration).toContain('UNIQUE INDEX `TELEGRAM_ACCOUNT_LINK_telegram_user_id_key` (`telegram_user_id`)');
    expect(migration).toContain('REFERENCES `USUARIO` (`id_usuario`) ON DELETE CASCADE');
  });

  it('stores only a unique code hash and supports expiry and one-time consumption', () => {
    expect(migration).toContain('`codigo_hash` CHAR(64) NOT NULL');
    expect(migration).toContain('UNIQUE INDEX `TELEGRAM_LINK_REQUEST_codigo_hash_key` (`codigo_hash`)');
    expect(migration).toContain('`expira_em` DATETIME(3) NOT NULL');
    expect(migration).toContain('`usado_em` DATETIME(3) NULL');
  });
});
