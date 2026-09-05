// Administrative recovery of official final scores, not a reconstruction of
// the original pre-match lineup. Existing round records are never overwritten.
require('dotenv').config();
const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();
const base = (process.env.CARTOLA_API_URL || 'https://api.cartolafc.globo.com').replace(/\/$/, '');
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Cartola HTTP ${response.status}: ${path}`);
  return response.json();
}
async function main() {
  const ids = [...new Set(process.argv.slice(2).flatMap((arg) => arg.split(';')).map(Number))];
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Informe IDs positivos.');
  const market = await get('/mercado/status');
  const temporada = market.temporada;
  const rodada = market.game_over ? market.rodada_atual : market.rodada_atual - 1;
  if (market.status_mercado !== 1 || !Number.isInteger(temporada) || !Number.isInteger(rodada)
    || rodada < 1 || rodada > 38) throw new Error('Exige mercado aberto e ultima rodada encerrada.');
  const round = await prisma.rodadaProcessamento.findUnique({ where: { temporada_rodada: { temporada, rodada } } });
  if (round?.status !== 'CONSOLIDADA') throw new Error('Recupere e consolide os atletas da rodada antes de importar times.');
  const teams = [];
  for (const id of ids) {
    const data = await get(`/time/id/${id}/${rodada}`);
    if (data.time?.time_id !== id || !data.time.nome || data.rodada_atual !== rodada) throw new Error(`Time/rodada divergente: ${id}`);
    teams.push(data);
  }
  const after = await get('/mercado/status');
  if (after.status_mercado !== 1 || after.temporada !== temporada || after.rodada_atual !== market.rodada_atual) {
    throw new Error('Mercado mudou durante importacao.');
  }
  const results = await prisma.$transaction(async (tx) => {
    const result = [];
    for (const data of teams) {
      const time = data.time;
      const timeId = time.time_id;
      await tx.timeCartola.upsert({ where: { timeId }, update: {}, create: {
        timeId, nomeTime: time.nome, nomeCartoleiro: time.nome_cartola ?? null,
        slug: time.slug ?? null, escudoUrl: time.url_escudo_png ?? null,
      } });
      const key = { timeId, temporada, rodada };
      if (await tx.timeRodada.findUnique({ where: { timeId_temporada_rodada: key } })) {
        result.push({ timeId, resultado: 'ja_existente' }); continue;
      }
      if (!Number.isFinite(data.pontos) || !Array.isArray(data.atletas) || !data.atletas.length) {
        result.push({ timeId, resultado: 'sem_pontuacao', mensagem: data.mensagem }); continue;
      }
      // Store the official total only. No historical frozen lineup is fabricated.
      await tx.timeRodada.create({ data: { ...key,
        pontuacao: { create: { pontuacao: new Prisma.Decimal(data.pontos).toDecimalPlaces(2),
          status: 'FINAL', consolidadoEm: new Date() } },
      } });
      result.push({ timeId, nome: time.nome, resultado: 'importado', pontos: Number(data.pontos.toFixed(2)) });
    }
    return result;
  });
  console.log(JSON.stringify({ temporada, rodada, results }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
