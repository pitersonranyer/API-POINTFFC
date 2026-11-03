CREATE TABLE `USUARIO` (
    `id_usuario` VARCHAR(36) NOT NULL,
    `firebase_uid` VARCHAR(128) NOT NULL,
    `nome` VARCHAR(255) NULL,
    `email` VARCHAR(255) NOT NULL,
    `foto_url` TEXT NULL,
    `tipo_usuario` ENUM('PLAYER', 'ORGANIZER', 'PLATFORM_ADMIN') NOT NULL DEFAULT 'PLAYER',
    `status` ENUM('ATIVO', 'INATIVO', 'BLOQUEADO') NOT NULL DEFAULT 'ATIVO',
    `data_criacao` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `data_atualizacao` DATETIME(3) NOT NULL,

    UNIQUE INDEX `USUARIO_firebase_uid_key`(`firebase_uid`),
    UNIQUE INDEX `USUARIO_email_key`(`email`),
    PRIMARY KEY (`id_usuario`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
