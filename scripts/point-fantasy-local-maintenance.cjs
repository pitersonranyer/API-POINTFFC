// Narrow capabilities for the existing admission service and backfill. No SQL writes here.
const fs = require('fs');
const bindings = new WeakMap();
function deny(reason) { const error = Error('ADMISSION_LOCAL_MAINTENANCE_' + reason); error.code = error.message; throw error; }
function destination(value) {
  const u = new URL(value);
  if (process.env.NODE_ENV?.toLowerCase() === 'production' || ['RENDER','RENDER_SERVICE_ID','RENDER_EXTERNAL_HOSTNAME'].some(k => process.env[k])
    || u.protocol !== 'mysql:' || u.hostname !== '127.0.0.1' || (u.port || '3306') !== '3306' || u.pathname !== '/fantasy_point_do_jogador' || u.search || u.hash) deny('DESTINATION_FORBIDDEN');
  return u;
}
function approvedPlan(grant) {
  const x = require('./point-fantasy-local-migrations.cjs');
  if (!grant || grant.approved !== true || grant.writersStopped !== true || !grant.operator?.trim()
    || grant.target !== '127.0.0.1:3306/fantasy_point_do_jogador' || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) deny('APPROVAL_REQUIRED');
  const plan = JSON.parse(fs.readFileSync(grant.planFile));
  if (!plan.homologated || x.hash(x.stable(plan)) !== grant.planHash || plan.identity.server !== grant.server
    || x.stable(plan.files) !== x.stable(x.sqlFiles()) || plan.backup.hash !== x.hash(fs.readFileSync(plan.backup.file))) deny('PLAN_CHANGED');
  return plan;
}
async function verifyDatabase(tx, url, grant, plan) {
  const x = require('./point-fantasy-local-migrations.cjs'); destination(url);
  const [i] = await tx.$queryRawUnsafe('SELECT DATABASE() AS name,@@server_uuid AS server,@@port AS port');
  if (i.name !== 'fantasy_point_do_jogador' || i.server !== grant.server || Number(i.port) !== 3306) deny('IDENTITY_CHANGED');
  const h = await x.history(tx);
  for (const [index, name] of x.names.entries()) {
    const rows = h.filter(r => r.migration_name === name);
    if (rows.some(r => r.checksum !== x.pinned[index]) || rows.filter(r => r.finished_at && !r.rolled_back_at).length !== 1) deny('MIGRATIONS_INVALID');
  }
  if (h.some(r => !r.finished_at && !r.rolled_back_at) || x.stable(h.filter(r => !x.names.includes(r.migration_name))) !== x.stable(plan.history)
    || await x.signature(tx) !== plan.boundaries[x.names[1]].at(-1)) deny('SCHEMA_OR_HISTORY_CHANGED');
}
async function state(tx, season, round, allowMissing = false) {
  // Same control-then-round lock order as persistent admission and the current collector.
  const [c] = await tx.$queryRawUnsafe('SELECT MODO,GERACAO FROM FANTASY_ESCRITA_CONTROLE WHERE TEMPORADA=? AND RODADA=? FOR UPDATE',season,round);
  const [r] = await tx.$queryRawUnsafe('SELECT ID,FENCE,REVISAO_ATUAL,HASH_CONTEUDO_ATUAL,LOCK_TOKEN,LOCK_ATE FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=? AND RODADA=? FOR UPDATE',season,round);
  if (!r && !c && allowMissing) return { expectedMode:null,expectedGeneration:0n,expectedFence:0n,expectedRevision:0n,expectedHash:null };
  if (!r || r.LOCK_TOKEN !== null || r.LOCK_ATE !== null) deny('SCOPE_NOT_DRAINED');
  const [pending] = await tx.$queryRawUnsafe("SELECT COUNT(*) AS n FROM FANTASY_PONTUACAO_COLETA WHERE RODADA_ID=? AND ESTADO='EM_ANDAMENTO'",r.ID);
  if (Number(pending.n)) deny('SCOPE_NOT_DRAINED');
  return { expectedMode: c?.MODO ?? null, expectedGeneration: c?.GERACAO ?? 0n, expectedFence: r.FENCE,
    expectedRevision: r.REVISAO_ATUAL, expectedHash: r.HASH_CONTEUDO_ATUAL };
}
function assertScope(auth, url, request, action) {
  const x = require('./point-fantasy-local-migrations.cjs'), b = bindings.get(auth);
  destination(url);
  if (!b || action !== b.action || x.stable(request) !== x.stable(b.request)) deny('CAPABILITY_SCOPE_MISMATCH');
  return b;
}
async function assertMaintenance(tx, auth, url, request, action) {
  const b = assertScope(auth,url,request,action);
  const plan = approvedPlan(b.grant);
  await verifyDatabase(tx, url, b.grant, plan);
  const current = await state(tx, request.season, request.round, action === 'INICIALIZAR');
  // AdmissionService performs its own complete audit comparison on UUID reuse.
  const prior = action === 'BACKFILL' ? null : await tx.fantasyEscritaTransicao.findUnique({ where: { operacaoId: request.operationId } });
  if (!prior && Object.entries(current).some(([k,v]) => v !== request[k])) deny('REFERENCE_CHANGED');
  if (action === 'BACKFILL' && current.expectedMode !== 'BLOQUEADO') deny('BACKFILL_NOT_BLOCKED');
}
async function authorizeMaintenance(db, url, grant, request, action) {
  const x = require('./point-fantasy-local-migrations.cjs'); destination(url); const plan = approvedPlan(grant);
  if (!Number.isInteger(grant.season) || grant.season < 2000 || grant.season > 65535 || !Number.isInteger(grant.round) || grant.round < 1 || grant.round > 38
    || request.season !== grant.season || request.round !== grant.round || request.operator !== grant.operator
    || !['INICIALIZAR','TRANSICIONAR','BACKFILL'].includes(action)) deny('REQUEST_FORBIDDEN');
  const key = action === 'INICIALIZAR' ? 'initialize' : action === 'BACKFILL' ? 'backfill' : request.target === 'BLOQUEADO' ? 'block' : request.target === 'ATUAL' ? 'enable' : '';
  if (!key || request.operationId !== grant.operationIds?.[key] || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.operationId)
    || (action === 'INICIALIZAR' && request.target !== 'LEGADO')) deny('OPERATION_FORBIDDEN');
  const auth = Object.freeze({}); bindings.set(auth, { action, request: Object.freeze({ ...request }), grant: Object.freeze(JSON.parse(JSON.stringify(grant))) });
  try { await db.$transaction(async tx => { await verifyDatabase(tx,url,grant,plan); await assertMaintenance(tx,auth,url,request,action); }, { isolationLevel:'Serializable',timeout:30000 }); }
  catch (error) { bindings.delete(auth); throw error; }
  return auth;
}
function boundBackfillRequest(auth, season, round, operationId) {
  const b = bindings.get(auth);
  if (!b || b.action !== 'BACKFILL' || b.request.season !== season || b.request.round !== round || b.request.operationId !== operationId) deny('CAPABILITY_SCOPE_MISMATCH');
  return b.request;
}
module.exports = { destination, state, authorizeMaintenance, assertScope, assertMaintenance, boundBackfillRequest };
