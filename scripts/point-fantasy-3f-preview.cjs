// Official service preview + migration preflight. No database writes or HTTP.
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { createHash } = require('crypto');
const { PrismaClient, Prisma } = require('@prisma/client');
const { LineupScoringService } = require('../src/point-fantasy/scoring/lineup-scoring.service');
const hash = value => createHash('sha256').update(value).digest('hex');
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'fantasy_point_do_jogador');
  assert.notEqual(process.env.NODE_ENV, 'production');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  try {
    const plan = await new LineupScoringService(db).preview(1);
    assert.equal(plan.competition.temporada, 2026); assert.equal(plan.competition.rodada, 31);
    assert.equal(plan.round.revisaoAtual, 2n); assert.equal(plan.results.length, 3);
    assert.ok(plan.completeness.eligible);
    assert.ok(plan.results.every(r => r.total !== null && !r.missing.length));
    const extra = await db.$transaction(async tx => {
      const [identity] = await tx.$queryRaw`SELECT DATABASE() AS name,VERSION() AS version`;
      assert.equal(identity.name, 'fantasy_point_do_jogador');
      const round = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { id: plan.round.id } });
      assert.equal(round.revisaoAtual, 2n); assert.equal(round.hashConteudoAtual, plan.round.hashConteudoAtual);
      const sourceRecords = await tx.fantasyPontuacaoAtleta.count({ where: { temporada: 2026, rodada: 31, apuracaoId: round.id } });
      assert.equal(sourceRecords, 306);
      const lineups = await tx.fantasyEscalacao.findMany({ where: { competicaoId: 1, status: 'INSCRITA' },
        include: { atletas: { include: { atleta: true } } }, orderBy: { id: 'asc' } });
      assert.deepEqual(lineups.map(l => l.id), [5,6,7]);
      assert.ok(lineups.every(l => l.confirmadaEm && plan.results.some(r => r.escalacaoId === l.id && r.versaoEscalacao === l.versao)));
      const history = await tx.$queryRaw`SELECT migration_name,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
      const migrations = ['0031_point_fantasy_lineup_results', '0032_point_fantasy_closure_audit'];
      const pending = fs.readdirSync(path.join(__dirname, '../prisma/migrations')).filter(n => /^\d/.test(n))
        .filter(n => !history.some(h => h.migration_name === n && h.finished_at && !h.rolled_back_at)).sort();
      assert.deepEqual(pending, migrations);
      assert.ok(history.every(h => h.finished_at || h.rolled_back_at));
      const columns = await tx.$queryRaw`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_COMPETICAO','FANTASY_ESCALACAO') AND COLUMN_NAME IN ('ID','COMPETICAO_ID')`;
      assert.ok(columns.length === 3 && columns.every(c => c.COLUMN_TYPE === 'int unsigned'));
      const existing = await tx.$queryRaw`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN ('FANTASY_ESCALACAO_RESULTADO','FANTASY_FECHAMENTO_AUDITORIA')`;
      assert.equal(existing.length, 0);
      const sql = migrations.map(name => {
        const content = fs.readFileSync(path.join(__dirname, '../prisma/migrations', name, 'migration.sql'), 'utf8');
        assert.ok(!/^\s*(DROP|DELETE|UPDATE|TRUNCATE|INSERT|CREATE DATABASE|USE)\b/im.test(content));
        return { name, sha256: hash(content), additive: true };
      });
      return { database: identity.name, mysqlVersion: identity.version, sourceRecords,
        migrations: sql, pending, activeAdmins: await tx.usuario.count({ where: { tipoUsuario: 'PLATFORM_ADMIN', status: 'ATIVO' } }),
        lineups: lineups.map(l => ({ id: l.id, nome: l.nomePublico, versao: l.versao, capitao: l.capitaoAtletaId,
          atletas: l.atletas.map(a => ({ id: a.catalogoAtletaId, nome: a.atleta.apelido, cartolaId: a.atleta.atletaIdExterno, papel: a.papel })) })) };
    }, { isolationLevel: 'RepeatableRead' });
    const results = plan.results.map(r => {
      const lineup = extra.lineups.find(l => l.id === r.escalacaoId);
      const name = id => lineup.atletas.find(a => a.id === id)?.nome ?? null;
      const sum = r.contributions.reduce((n,c) => n.plus(c.points), new (Prisma.Decimal.clone({precision:80}))(0));
      assert.ok(sum.eq(r.total));
      return { ...r, nome: lineup.nome, somaConferida: sum.toFixed(),
        substitutions: r.substitutions.map(s => ({ ...s, saiu: name(s.out), entrou: name(s.in) })),
        contributions: r.contributions.map(c => ({ ...c, titular: name(c.starter), atleta: name(c.athlete) })) };
    });
    const report = { date: new Date().toISOString(), ...extra, revision: plan.round.revisaoAtual,
      sourceHash: plan.round.hashConteudoAtual, evidence: plan.completeness,
      fechamentoDefinitivoEm: plan.competition.fechamentoDefinitivoEm,
      closureReadyAfterMigrations: plan.completeness.eligible && plan.competition.fimInscricao <= new Date() && extra.activeAdmins > 0,
      results, databaseWrites: 0 };
    const output = JSON.stringify(report, (_,v) => typeof v === 'bigint' ? v.toString() : v, 2);
    fs.writeFileSync(path.join(__dirname, '../docs/point-fantasy-3f-preview.json'), output + '\n');
    console.log(output);
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(error => {
  console.error(error.code || (error.name === 'AssertionError' ? 'PREVIEW_SCOPE_OR_EXPECTATIONS_DIVERGED' : 'READ_ONLY_3F_PREVIEW_FAILED'));
  if (error.name === 'AssertionError') console.error(error.stack?.match(/point-fantasy-3f-preview\.cjs:\d+:\d+/)?.[0] ?? 'AUDIT_ASSERTION');
  process.exitCode = 1;
});
module.exports = { main };
