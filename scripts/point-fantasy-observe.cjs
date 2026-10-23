require('reflect-metadata');
require('dotenv').config();
const { randomUUID } = require('crypto');
async function main() {
  const [season, round, operation = randomUUID(), ...extra] = process.argv.slice(2);
  if (extra.length || !season || !round) throw new Error('Usage: node scripts/point-fantasy-observe.cjs TEMPORADA RODADA [UUID]');
  const target = new URL(process.env.DATABASE_URL);
  if (process.env.NODE_ENV === 'production' || target.protocol !== 'mysql:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('LOCAL_DATABASE_REQUIRED');
  // Instantiate only the observation service; never bootstrap AppModule or traditional jobs.
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { ObservationService } = require('../dist/point-fantasy/observation/observation.service');
  const { CartolaObservationSource } = require('../dist/point-fantasy/observation/observation-source');
  const db = new PrismaService();
  try { console.log(JSON.stringify(await new ObservationService(db, new CartolaObservationSource())
    .collect(Number(season), Number(round), operation), null, 2)); }
  finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error.code || (['LOCAL_DATABASE_REQUIRED'].includes(error.message) ? error.message : 'OBSERVATION_FAILED')); process.exitCode = 1; });
