import { readFileSync } from 'fs';
import { join } from 'path';

describe('Telegram wallet migration 0023', () => {
  const migration = readFileSync(
    join(__dirname, '../prisma/migrations/0023_telegram_wallet_request/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');

  it('keeps every SQL identifier within the MySQL 64-character limit', () => {
    const identifiers = Array.from(migration.matchAll(/`([^`]+)`/g), (match) => match[1]);
    expect(identifiers.length).toBeGreaterThan(0);
    expect(identifiers.filter((identifier) => Array.from(identifier).length > 64)).toEqual([]);
  });

  it.each([
    ['TG_WALLET_REQUEST_TELEGRAM_USUARIO_CRIADO_idx', ['telegram_user_id', 'usuario_id', 'criado_em'], ['telegramUserId', 'usuarioId', 'criadoEm']],
    ['TG_WALLET_REQUEST_USUARIO_CONFIRMADO_EXPIRA_idx', ['usuario_id', 'confirmado_em', 'expira_em'], ['usuarioId', 'confirmadoEm', 'expiraEm']],
  ])('maps index %s to the same ordered columns in SQL and Prisma', (name, columns, fields) => {
    expect(migration).toContain(`INDEX \`${name}\` (${columns.map((column) => `\`${column}\``).join(', ')})`);
    const model = schema.match(/model TelegramWalletRequest \{([\s\S]*?)\n\}/)?.[1];
    expect(model).toContain(`@@index([${fields.join(', ')}], map: "${name}")`);
  });

  it('preserves unique keys and foreign key relationships', () => {
    expect(migration).toContain('UNIQUE INDEX `TELEGRAM_WALLET_REQUEST_idempotency_key_key` (`idempotency_key`)');
    expect(migration).toContain('UNIQUE INDEX `TELEGRAM_WALLET_REQUEST_recarga_id_key` (`recarga_id`)');
    expect(migration).toContain('PRIMARY KEY (`id`)');
    expect(migration).toContain('FOREIGN KEY (`usuario_id`) REFERENCES `USUARIO` (`id_usuario`) ON DELETE CASCADE ON UPDATE CASCADE');
    expect(migration).toContain('FOREIGN KEY (`recarga_id`) REFERENCES `RECARGA_CARTEIRA` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
  });
});
