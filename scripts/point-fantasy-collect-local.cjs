// One explicit collection. Never bootstraps AppModule, schedulers or migrations.
const fs = require('fs');
const { createHash } = require('crypto');
const path = require('path');
function parseArgs(args) {
  const prepareReview = args[0] === 'prepare-review';
  const prepare = args[0] === 'prepare' || prepareReview;
  const values = prepare ? args.slice(1) : args;
  const [season, round, operationId, option, authorizationFile, ...extra] = values;
  if ((prepareReview ? extra.length !== 2 || extra[0] !== '--review' || !/^[1-9]\d*$/.test(extra[1]) : extra.length) || !/^\d+$/.test(season || '') || !/^\d+$/.test(round || '') || Number(season) < 2000 || Number(season) > 65535
    || Number(round) < 1 || Number(round) > 38 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId || '')
    || option !== '--authorization' || !authorizationFile) throw Error('USE_SEASON_ROUND_UUID_AUTHORIZATION_FILE');
  return { prepare, prepareReview, reviewId: prepareReview ? Number(extra[1]) : undefined, season: Number(season), round: Number(round), operationId, authorizationFile };
}
async function main(args = process.argv.slice(2)) {
  const input = parseArgs(args);
  require('reflect-metadata');
  require('dotenv').config({ quiet: true });
  const auth = require('../dist/point-fantasy/observation/local-scoring-authorization');
  const target = auth.localScoringDestination(process.env.DATABASE_URL, true);
  for (const [name, expected] of Object.entries(auth.localScoringMigrations)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../prisma/migrations', name, 'migration.sql'))).digest('hex');
    if (actual !== expected) throw Error('ADMISSION_LOCAL_MIGRATION_FILE_CHANGED');
  }
  // Parse approval before opening a connection on the collection path.
  const approval = input.prepare ? null : JSON.parse(fs.readFileSync(input.authorizationFile, 'utf8'));
  if (approval && (approval.season !== input.season || approval.round !== input.round || approval.operationId !== input.operationId)) throw Error('ADMISSION_LOCAL_SCOPE_MISMATCH');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const db = new PrismaService({ datasources: { db: { url: target.toString() } } });
  try {
    if (input.prepare) {
      const draft = input.prepareReview
        ? await auth.prepareLocalReviewApproval(db,target.toString(),input.season,input.round,input.operationId,input.reviewId)
        : await auth.prepareLocalScoringApproval(db, target.toString(), input.season, input.round, input.operationId);
      fs.writeFileSync(input.authorizationFile, JSON.stringify(draft, null, 2), { flag: 'wx' });
      return { prepared: true, approved: false, authorizationFile: input.authorizationFile, expiresAt: draft.expiresAt };
    }
    if (!approval.reason?.trim()) throw Error('ADMISSION_LOCAL_JUSTIFICATION_REQUIRED');
    const capability = await auth.authorizeLocalScoring(db, target.toString(), approval);
    const { CurrentScoringService } = require('../dist/point-fantasy/observation/current-scoring.service');
    const { partialScoringPolicy } = require('../dist/point-fantasy/observation/current-scoring-policy');
    const { CartolaObservationSource } = require('../dist/point-fantasy/observation/observation-source');
    const source = approval.review ? await auth.reviewedObservationSource(db,approval) : new CartolaObservationSource();
    const result = await new CurrentScoringService(db, source, target.toString(), partialScoringPolicy, capability)
      .collect(input.season, input.round, input.operationId);
    return { target: '127.0.0.1:3306/fantasy_point_do_jogador', season: input.season, round: input.round, operator: approval.operator, policy: 'partial-v1', ...result };
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().then(result => {
  console.log(JSON.stringify(result, null, 2));
  if (!result.prepared && result.estado !== 'SUCESSO') process.exitCode = 1;
}).catch(error => { console.error(JSON.stringify({ error: /^[A-Z_0-9]+$/.test(error.code || error.message || '') ? (error.code || error.message) : 'LOCAL_SCORING_FAILED' })); process.exitCode = 1; });
module.exports = { main, parseArgs };
