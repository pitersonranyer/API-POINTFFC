const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const fail = code => { throw new Error(code); };
function destination(url) {
  const u = new URL(url);
  if (process.env.NODE_ENV === 'production' || u.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) fail('LOCAL_REQUIRED');
  return { host: u.hostname, port: u.port || '3306', schema: decodeURIComponent(u.pathname.slice(1)) };
}
function migrations(root, history) {
  const base = path.join(root, 'prisma', 'migrations');
  const entries = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    if (!/^\d+_[a-z0-9_]+$/.test(e.name)) fail('INVALID_MIGRATION_NAME');
    return { name: e.name, hash: hash(fs.readFileSync(path.join(base, e.name, 'migration.sql'))) };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (history.some(h => !h.finished_at && !h.rolled_back_at)) fail('UNRESOLVED_MIGRATION');
  const applied = new Set(history.filter(h => h.finished_at && !h.rolled_back_at).map(h => h.migration_name));
  if ([...applied].some(name => !entries.some(e => e.name === name))) fail('APPLIED_MIGRATION_MISSING');
  return { entries, pending: entries.filter(e => !applied.has(e.name)), historyHash: digest(history) };
}
function artifacts(root) {
  const names = ['package.json', 'prisma/schema.prisma', 'tsconfig.json', 'tsconfig.build.json'];
  if (fs.existsSync(path.join(root, 'package-lock.json'))) names.push('package-lock.json');
  for (const folder of ['src/point-fantasy/observation', 'src/prisma', 'scripts', 'test']) {
    for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (folder === 'scripts' && !entry.name.startsWith('point-fantasy-observ')) continue;
      if (folder === 'test' && !entry.name.startsWith('point-fantasy-observation')) continue;
      names.push(folder + '/' + entry.name);
    }
  }
  return names.sort().map(name => ({ name, hash: hash(fs.readFileSync(path.join(root, name))) }));
}
function capture(root, url, history) {
  const manifest = { target: destination(url), ...migrations(root, history) };
  const files = artifacts(root);
  return { manifest, manifestHash: digest(manifest), artifactsHash: digest(files) };
}
function assertRehearsal(state, current) {
  if (state.formatVersion !== 2 || !state.rehearsal?.success || !state.rehearsalId) fail('REHEARSAL_REQUIRED');
  if (state.context.manifestHash !== current.manifestHash) fail('MIGRATION_MANIFEST_CHANGED');
  if (state.context.artifactsHash !== current.artifactsHash) fail('ARTIFACTS_CHANGED_REHEARSAL_REQUIRED');
  if (!/^point_fantasy_observation_3b2_test_\d+$/.test(state.testSchema)) fail('TEST_SCHEMA_REQUIRED');
  if (state.rehearsal.testSchema !== state.testSchema) fail('TEST_DESTINATION_CHANGED');
}
function assertApply(state, current) {
  assertRehearsal(state, current);
  const a = state.approval;
  if (!state.testsPassed || !a || a.rehearsalId !== state.rehearsalId || a.testSchema !== state.testSchema
    || a.manifestHash !== current.manifestHash || a.artifactsHash !== current.artifactsHash
    || a.attemptId !== state.testAttempt?.id || state.testAttempt?.outcome !== 'PASSED') fail('VALID_TEST_APPROVAL_REQUIRED');
}
async function runApprovedTests({ state, save, current, run }) {
  state.testsPassed = false; state.approval = null;
  state.testAttempt = { id: randomUUID(), startedAt: new Date().toISOString(), outcome: 'RUNNING' };
  save(state);
  try {
    const before = await current(); assertRehearsal(state, before);
    Object.assign(state.testAttempt, { manifestHash: before.manifestHash, artifactsHash: before.artifactsHash,
      testSchema: state.testSchema, rehearsalId: state.rehearsalId });
    save(state);
    const result = await run();
    if (result.status !== 0 || result.error || result.signal) fail('ISOLATED_TESTS_FAILED');
    const after = await current(); assertRehearsal(state, after);
    if (digest(before) !== digest(after)) fail('ARTIFACTS_CHANGED_DURING_TEST');
    state.testsPassed = true; state.testAttempt.outcome = 'PASSED';
    state.approval = { attemptId: state.testAttempt.id, rehearsalId: state.rehearsalId, testSchema: state.testSchema,
      manifestHash: after.manifestHash, artifactsHash: after.artifactsHash };
  } catch (error) {
    state.testsPassed = false; state.approval = null; state.testAttempt.outcome = 'FAILED'; throw error;
  } finally { state.testAttempt.finishedAt = new Date().toISOString(); save(state); }
}
module.exports = { hash, capture, destination, assertRehearsal, assertApply, runApprovedTests };
