// Execute only phase suites against the two explicitly rehearsed local schemas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { isolatedUrl } = require('./point-fantasy-scoring-backfill.cjs');
const { fingerprint } = require('./point-fantasy-scoring-rehearsal.cjs');
async function main() {
  require('dotenv').config({ quiet: true });
  const source = new URL(process.env.DATABASE_URL);
  if (source.hostname !== '127.0.0.1' || source.pathname !== '/fantasy_point_do_jogador'
    || source.protocol !== 'mysql:' || process.env.NODE_ENV === 'production') throw new Error('EXPECTED_LOCAL_SOURCE_REQUIRED');
  const evidence = fs.readFileSync(path.join(os.tmpdir(), 'point-fantasy-3b33a2-location.txt'), 'utf8');
  if (!path.resolve(evidence).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('TEMP_EVIDENCE_REQUIRED');
  const state = JSON.parse(fs.readFileSync(path.join(evidence, 'rehearsal.json'), 'utf8'));
  const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/0029_point_fantasy_current_scoring/migration.sql'));
  if (!state.success || !state.equalStructures || !state.sourceUnchanged
    || createHash('sha256').update(sql).digest('hex') !== state.migrationHash) throw new Error('UNCHANGED_SUCCESSFUL_REHEARSAL_REQUIRED');
  const a = new URL(source), b = new URL(source);
  a.pathname = '/' + state.scenarios.A.schema; b.pathname = '/' + state.scenarios.B.schema;
  isolatedUrl(a.toString()); isolatedUrl(b.toString());
  const db = new PrismaClient({ datasources: { db: { url: source.toString() } }, log: [] });
  const testClients = [a, b].map(url => new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] }));
  try {
    if (JSON.stringify(await fingerprint(db)) !== JSON.stringify(state.sourceBefore)) throw new Error('SOURCE_CHANGED');
    const baselines = await Promise.all(testClients.map(client => fingerprint(client)));
    const legacyCollections = await Promise.all(testClients.map(client => client.$queryRawUnsafe(
      'SELECT * FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID')));
    const r = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--no-cache',
      '--testPathPattern=point-fantasy-(scoring-structure|observation|current-scoring)', '--json', '--outputFile=' + path.join(evidence, 'tests-final.json')], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: b.toString(),
        POINT_FANTASY_SCORING_A_URL: a.toString(), POINT_FANTASY_SCORING_B_URL: b.toString(),
        POINT_FANTASY_OBSERVATION_TEST_DATABASE_URL: b.toString(), POINT_FANTASY_CURRENT_TEST_DATABASE_URL: b.toString() },
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    const log = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(path.join(evidence, 'tests-final.log'), log);
    process.stdout.write(log);
    if (JSON.stringify(await fingerprint(db)) !== JSON.stringify(state.sourceBefore)) throw new Error('SOURCE_CHANGED');
    for (const [index, client] of testClients.entries()) {
      const after = await fingerprint(client);
      for (const [name, before] of Object.entries(baselines[index])) {
        if (name.startsWith('fantasy_pontuacao_') || name === 'fantasy_apuracao_rodada') continue;
        if (JSON.stringify(after[name]) !== JSON.stringify(before)) throw new Error('TRADITIONAL_OR_HISTORY_CHANGED');
      }
      const stable = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString()
        : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
      const currentLegacy = await client.$queryRawUnsafe('SELECT * FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID');
      if (stable(currentLegacy) !== stable(legacyCollections[index])) throw new Error('LEGACY_COLLECTION_CHANGED');
      for (const [table, key] of [['fantasy_pontuacao_snapshot', 'ID'], ['fantasy_pontuacao_atleta_snapshot', 'SNAPSHOT_ID']]) {
        const original = await client.$queryRawUnsafe('SELECT * FROM ' + table + ' WHERE ' + key + '=1');
        const digest = createHash('sha256').update(JSON.stringify(original.map(row => stable(row)).sort())).digest('hex');
        if (digest !== state.sourceBefore[table].data) throw new Error('LEGACY_SNAPSHOT_CHANGED');
      }
    }
    fs.writeFileSync(path.join(evidence, 'post-tests-integrity.json'), JSON.stringify({
      sourceUnchanged: true, traditionalTablesAndHistoryUnchanged: true, originalSnapshotUnchanged: true, legacyCollectionsUnchanged: true,
      testsPassed: r.status === 0 && !r.error && !r.signal,
    }, null, 2));
    if (r.status !== 0 || r.error || r.signal) throw new Error('ISOLATED_TESTS_FAILED');
  } finally { await Promise.all(testClients.map(client => client.$disconnect())); await db.$disconnect(); }
}
if (require.main === module) main().catch(error => {
  console.error(/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'SCORING_TEST_FAILED'); process.exitCode = 1;
});
