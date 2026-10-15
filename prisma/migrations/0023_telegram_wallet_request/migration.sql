-- Durable Telegram-to-wallet operation key. Retrying a confirmed request after
-- process restart reuses the same RecargaPixService idempotency key.
CREATE TABLE `TELEGRAM_WALLET_REQUEST` (
  `id` VARCHAR(36) NOT NULL,
  `telegram_user_id` VARCHAR(32) NOT NULL,
  `usuario_id` INTEGER UNSIGNED NOT NULL,
  `idempotency_key` VARCHAR(36) NOT NULL,
  `valor` DECIMAL(12, 2) NOT NULL,
  `expira_em` DATETIME(3) NOT NULL,
  `confirmado_em` DATETIME(3) NULL,
  `recarga_id` INTEGER UNSIGNED NULL,
  `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `atualizado_em` DATETIME(3) NOT NULL,
  UNIQUE INDEX `TELEGRAM_WALLET_REQUEST_idempotency_key_key` (`idempotency_key`),
  UNIQUE INDEX `TELEGRAM_WALLET_REQUEST_recarga_id_key` (`recarga_id`),
  INDEX `TG_WALLET_REQUEST_TELEGRAM_USUARIO_CRIADO_idx` (`telegram_user_id`, `usuario_id`, `criado_em`),
  INDEX `TG_WALLET_REQUEST_USUARIO_CONFIRMADO_EXPIRA_idx` (`usuario_id`, `confirmado_em`, `expira_em`),
  PRIMARY KEY (`id`),
  CONSTRAINT `TELEGRAM_WALLET_REQUEST_usuario_id_fkey`
    FOREIGN KEY (`usuario_id`) REFERENCES `USUARIO` (`id_usuario`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TELEGRAM_WALLET_REQUEST_recarga_id_fkey`
    FOREIGN KEY (`recarga_id`) REFERENCES `RECARGA_CARTEIRA` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
