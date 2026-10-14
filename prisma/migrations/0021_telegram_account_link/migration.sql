CREATE TABLE `TELEGRAM_ACCOUNT_LINK` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `usuario_id` INTEGER UNSIGNED NOT NULL,
  `telegram_user_id` VARCHAR(32) NOT NULL,
  `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `TELEGRAM_ACCOUNT_LINK_usuario_id_key` (`usuario_id`),
  UNIQUE INDEX `TELEGRAM_ACCOUNT_LINK_telegram_user_id_key` (`telegram_user_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `TELEGRAM_ACCOUNT_LINK_usuario_id_fkey`
    FOREIGN KEY (`usuario_id`) REFERENCES `USUARIO` (`id_usuario`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TELEGRAM_LINK_REQUEST` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `telegram_user_id` VARCHAR(32) NOT NULL,
  `codigo_hash` CHAR(64) NOT NULL,
  `expira_em` DATETIME(3) NOT NULL,
  `usado_em` DATETIME(3) NULL,
  `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `TELEGRAM_LINK_REQUEST_codigo_hash_key` (`codigo_hash`),
  INDEX `TELEGRAM_LINK_REQUEST_telegram_user_id_criado_em_idx` (`telegram_user_id`, `criado_em`),
  INDEX `TELEGRAM_LINK_REQUEST_expira_em_usado_em_idx` (`expira_em`, `usado_em`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
