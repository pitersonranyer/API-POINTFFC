require('reflect-metadata');
require('dotenv').config();
const { ConfigService } = require('@nestjs/config');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { FootballDataClient } = require('../dist/futebol/football-data.client');
const { FutebolSyncService } = require('../dist/futebol/futebol-sync.service');
const { FUTEBOL_COMPETICOES } = require('../dist/futebol/futebol-competicoes');
const prisma = new PrismaService();
const sync = new FutebolSyncService(prisma, new FootballDataClient(new ConfigService()));
(async () => {
  for (const code of FUTEBOL_COMPETICOES) {
    try {
      const result = await sync.syncCompeticao(code);
      console.log(JSON.stringify({ code, ...result, exemplos: undefined }));
    } catch (error) {
      console.error(JSON.stringify({ code, error: error.message.startsWith('football-data:') ? error.message : 'Falha no banco ou na sincronização.' }));
      process.exitCode = 1;
    }
  }
})().finally(() => prisma.$disconnect());
