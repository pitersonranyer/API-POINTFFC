require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { FutebolQueryService } = require('../dist/futebol/futebol-query.service');
const prisma = new PrismaClient();
(async () => {
  const query = new FutebolQueryService(prisma);
  const competitions = await query.listarCompeticoes();
  console.log('GET /futebol/competicoes', competitions.map(c => c.codigo));
  for (const c of competitions) {
    const matches = await prisma.futebolPartida.findMany({ where: { competicao: { codigo: c.codigo }, temporada: c.temporadaAtual }, select: { externalId: true, timeMandanteId: true, timeVisitanteId: true } });
    const ids = [...new Set(matches.flatMap(m => [m.timeMandanteId, m.timeVisitanteId]))];
    const linked = await prisma.futebolTime.count({ where: { id: { in: ids }, cartolaClubeId: { not: null } } });
    console.log(JSON.stringify({ codigo: c.codigo, clubes: ids.length, partidas: matches.length, duplicadas: matches.length - new Set(matches.map(m => m.externalId)).size, clubesCartola: linked }));
  }
  for (const code of ['PL', 'PD', 'CL']) {
    const result = await query.consultarRodadaAtual(code);
    console.log(`GET /futebol/competicoes/${code}/rodada-atual`, JSON.stringify({ rodada: result.rodada, total: result.total, cartolaNulo: result.jogos.every(j => j.mandante.cartolaClubeId === null && j.visitante.cartolaClubeId === null) }));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
