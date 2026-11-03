// Corrective phase runner: SELECT-only verification, then tests in an existing isolated schema.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { hash, destination } = require('./point-fantasy-observation-safety.cjs');
async function main() {
  const target = new URL(process.env.DATABASE_URL); destination(target.toString());
  const baseline = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'point-fantasy-3b31-baseline.json'), 'utf8'));
  if (!/^point_fantasy_observation_3b2_test_\d+$/.test(baseline.testSchema) || target.pathname === '/' + baseline.testSchema) throw new Error('ISOLATED_TEST_REQUIRED');
  const testTarget = new URL(target); testTarget.pathname = '/' + baseline.testSchema;
  const db = new PrismaClient({ datasources: { db: { url: testTarget.toString() } }, log: [] });
  try {
    const history = await db.$queryRawUnsafe('SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');
    const files = fs.readdirSync('prisma/migrations', { withFileTypes: true }).filter(e => e.isDirectory());
    if (history.length !== files.length) throw new Error('TEST_HISTORY_CHANGED');
    for (const row of history) {
      if (!/^\d+_[a-z0-9_]+$/.test(row.migration_name) || hash(fs.readFileSync('prisma/migrations/' + row.migration_name + '/migration.sql')) !== row.checksum) throw new Error('TEST_HISTORY_CHANGED');
    }
    const tables = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_APURACAO_RODADA','FANTASY_PONTUACAO_COLETA','FANTASY_PONTUACAO_SNAPSHOT','FANTASY_PONTUACAO_ATLETA_SNAPSHOT')");
    if (Number(tables[0].n) !== 4) throw new Error('TEST_STRUCTURE_INCOMPLETE');
  } finally { await db.$disconnect(); }
  const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--testPathPattern=point-fantasy-observation'], {
    env: { ...process.env, POINT_FANTASY_OBSERVATION_TEST_DATABASE_URL: testTarget.toString() }, stdio: 'inherit',
  });
  if (result.status !== 0 || result.error || result.signal) throw new Error('ISOLATED_TESTS_FAILED');
  // Does not issue a migration approval or modify the prior rehearsal state.
}
if (require.main === module) main().catch(() => { console.error('OBSERVATION_CHECK_FAILED'); process.exitCode = 1; });
