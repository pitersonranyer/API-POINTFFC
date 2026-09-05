require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const base = (process.env.CARTOLA_API_URL || 'https://api.cartolafc.globo.com').replace(/\/$/, '');

async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Cartola: HTTP ${response.status} em ${path}`);
  return response.json();
}

async function recover() {
  const market = await get('/mercado/status');
  const temporada = market.temporada;
  const rodada = market.game_over ? market.rodada_atual : market.rodada_atual - 1;
  if (market.status_mercado !== 1 || !Number.isInteger(temporada) || temporada < 1
    || !Number.isInteger(rodada) || rodada < 1 || rodada > 38) {
    throw new Error('Recuperacao exige mercado aberto e rodada anterior na temporada atual.');
  }
  const key = { temporada, rodada };
  const where = { temporada_rodada: key };
  if (await prisma.rodadaProcessamento.findUnique({ where })) {
    console.log('Rodada ja registrada; nenhum dado alterado.');
    return;
  }
  const [pontuados, partidas] = await Promise.all([get(`/atletas/pontuados/${rodada}`), get(`/partidas/${rodada}`)]);
  if (pontuados.rodada !== rodada || !pontuados.atletas || !Object.keys(pontuados.atletas).length
    || partidas.rodada !== rodada || !Array.isArray(partidas.partidas) || !partidas.partidas.length) {
    throw new Error('Fonte sem pontuados/partidas validos para a rodada solicitada.');
  }
  const after = await get('/mercado/status');
  if (after.temporada !== temporada || after.rodada_atual !== market.rodada_atual || after.status_mercado !== 1) {
    throw new Error('Mercado mudou durante recuperacao; tente novamente.');
  }
  const snapshots = await prisma.timeRodada.findMany({ where: key, select: { timeId: true } });
  // Recover official athlete data only; the worker validates existing team snapshots
  // and performs consolidation. Never invent historical lineups or team scores.
  await prisma.rodadaProcessamento.upsert({ where, update: {}, create: {
    ...key, pontuados, partidas, timesPrevistos: snapshots.map((team) => team.timeId),
    falhasSnapshot: [], status: 'AGUARDANDO_CONSOLIDACAO',
  } });
  console.log(JSON.stringify({ temporada, rodada, atletas: Object.keys(pontuados.atletas).length,
    message: 'Atletas recuperados. Consolidacao de times fica a cargo do processamento de rodadas.' }));
}

recover().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
