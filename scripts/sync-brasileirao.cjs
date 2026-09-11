require('reflect-metadata');
require('dotenv').config();
const { ConfigService } = require('@nestjs/config');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { FootballDataClient } = require('../dist/futebol/football-data.client');
const { FutebolSyncService } = require('../dist/futebol/futebol-sync.service');
const { FootballDataError } = require('../dist/futebol/football-data.normalizer');
const prisma = new PrismaService();
new FutebolSyncService(prisma, new FootballDataClient(new ConfigService())).syncBrasileirao()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error instanceof FootballDataError ? error.message : 'Sincronização falhou no banco; verifique conexão e migrations.');
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
