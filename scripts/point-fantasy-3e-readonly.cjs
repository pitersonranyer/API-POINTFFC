// Read-only R31 homologation. Does not import or run a collector/migration runner.
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { LineupScoringService } = require('../src/point-fantasy/scoring/lineup-scoring.service');
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'fantasy_point_do_jogador');
  assert.notEqual(process.env.NODE_ENV, 'production');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  try {
    const plan = await new LineupScoringService(db).preview(1);
    assert.equal(plan.competition.temporada, 2026); assert.equal(plan.competition.rodada, 31);
    assert.equal(plan.round.revisaoAtual, 2n); assert.equal(plan.results.length, 3);
    const details = await db.$transaction(async tx => {
      const [identity] = await tx.$queryRaw`SELECT DATABASE() AS name, VERSION() AS version`;
      assert.equal(identity.name, 'fantasy_point_do_jogador');
      const round = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { id: plan.round.id } });
      assert.equal(round.revisaoAtual, 2n); assert.equal(round.hashConteudoAtual, plan.round.hashConteudoAtual);
      const points = await tx.fantasyPontuacaoAtleta.findMany({ where: { temporada: 2026, rodada: 31, apuracaoId: round.id } });
      assert.equal(points.length, 306);
      const ids = [92171, 92087, 72460, 110668, 85626, 114802]; // Validate reported identities only; never a zero rule.
      assert.ok(ids.every(id => !points.some(p => p.atletaIdCartola === id)));
      const absent = await tx.fantasyCatalogoAtleta.findMany({ where: { catalogoId: plan.competition.catalogoId,
        atletaIdExterno: { in: ids } }, select: { id: true, atletaIdExterno: true, apelido: true, clubeIdExterno: true, posicaoId: true } });
      assert.equal(absent.length, 6);
      const collection = await tx.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id: round.ultimaColetaAplicadaId } });
      const tables = await tx.$queryRaw`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_COMPETICAO','FANTASY_ESCALACAO')
        AND COLUMN_NAME IN ('ID','COMPETICAO_ID') ORDER BY TABLE_NAME,COLUMN_NAME`;
      const history = await tx.$queryRaw`SELECT migration_name,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
      const pending = fs.readdirSync(path.join(__dirname, '../prisma/migrations')).filter(n => /^\d/.test(n))
        .filter(n => !history.some(h => h.migration_name === n && h.finished_at && !h.rolled_back_at)).sort();
      assert.deepEqual(pending, ['0031_point_fantasy_lineup_results', '0032_point_fantasy_closure_audit']);
      const structures = await tx.$queryRaw`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN ('FANTASY_ESCALACAO_RESULTADO','FANTASY_FECHAMENTO_AUDITORIA')`;
      assert.equal(structures.length, 0);
      const indexes = await tx.$queryRaw`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='FANTASY_ESCALACAO' AND INDEX_NAME='FE_RESULTADO_OWNER_key'`;
      assert.equal(indexes.length, 0);
      return { database: identity.name, mysqlVersion: identity.version, sourceRecords: points.length, missingIdentities: absent,
        collection: { id: collection.id, model: collection.modeloPersistencia, status: collection.estado,
          revision: collection.revisaoResultante, hash: collection.hashConteudo, payloadHash: collection.hashPayload,
          limitations: collection.limitacoes, matchEvidence: collection.evidenciasPartidas },
        migration: { pending, idColumns: tables, resultTableExists: false, closureAuditTableExists: false,
          migration0031Hash: createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../prisma/migrations/0031_point_fantasy_lineup_results/migration.sql'))).digest('hex') } };
    }, { isolationLevel: 'RepeatableRead' });
    const report = { date: new Date().toISOString(), ...details, competition: {
      id: 1, temporada: 2026, rodada: 31, fechamentoDefinitivoEm: plan.competition.fechamentoDefinitivoEm,
      matches: plan.competition.partidas.map(m => ({ id: m.partidaIdExterno, home: m.clubeMandanteId, away: m.clubeVisitanteId, status: m.status })) },
      round: { revision: plan.round.revisaoAtual, hash: plan.round.hashConteudoAtual },
      completeness: plan.completeness, previews: plan.results,
      writesPerformed: false, closuresPerformed: 0, migrationsApplied: 0, persistedResults: 0 };
    const output = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
    fs.writeFileSync(path.join(__dirname, '../docs/point-fantasy-3e-readonly.json'), output + '\n');
    console.log(output);
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(error => {
  console.error(error.code || (error.name === 'AssertionError' ? 'EXPECTED_LOCAL_SCOPE_DIVERGED' : 'READ_ONLY_3E_FAILED'));
  process.exitCode = 1;
});
module.exports = { main };
