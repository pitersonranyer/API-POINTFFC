// Local read-only verification. Never bootstraps Nest, migrations or schedulers.
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const assert = require('assert/strict');
const fs = require('fs');
const { createHash } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { LineupService } = require('../src/point-fantasy/lineups/lineup.service');
const { PointFantasyService } = require('../src/point-fantasy/point-fantasy.service');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname), 'Local MySQL required');
assert.equal(url.pathname, '/fantasy_point_do_jogador');
const db = new PrismaClient();
const serialize = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
const hash = v => createHash('sha256').update(serialize(v)).digest('hex');
async function snapshot() {
  return hash(await db.$transaction(async tx => ({
    competitions: await tx.fantasyCompeticao.findMany({ orderBy: { id: 'asc' } }),
    lineups: await tx.fantasyEscalacao.findMany({ orderBy: { id: 'asc' }, include: { atletas: { orderBy: { id: 'asc' } } } }),
    results: await tx.fantasyEscalacaoResultado.findMany({ orderBy: { escalacaoId: 'asc' } }),
    closure: await tx.fantasyFechamentoAuditoria.findMany({ orderBy: { competicaoId: 'asc' } }),
    rounds: await tx.fantasyApuracaoRodada.findMany({ orderBy: { id: 'asc' } }),
    points: await tx.fantasyPontuacaoAtleta.findMany({ orderBy: [{ temporada: 'asc' }, { rodada: 'asc' }, { atletaIdCartola: 'asc' }] }),
  })));
}
async function main() {
  // Reject model writes; invoked services only issue SELECT queries.
  db.$use(async (params, next) => {
    assert.ok(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'queryRaw'].includes(params.action), 'Read-only operations required');
    return next(params);
  });
  const [identity] = await db.$queryRaw`SELECT DATABASE() AS name`;
  assert.equal(identity.name, 'fantasy_point_do_jogador');
  const before = await snapshot();
  const c = await db.fantasyCompeticao.findUniqueOrThrow({ where: { id: 1 } });
  assert.equal(c.temporada, 2026); assert.equal(c.rodada, 31); assert.ok(c.fechamentoDefinitivoEm);
  const enrolled = await db.fantasyEscalacao.findMany({ where: { competicaoId: 1, status: 'INSCRITA' }, orderBy: { id: 'asc' } });
  assert.deepEqual(enrolled.map(l => l.id), [5, 6, 7]);
  const owner = enrolled[0].usuarioId;
  assert.ok(enrolled.every(l => l.usuarioId === owner));
  const service = new LineupService(db);
  const list = await service.list(owner, 1, { page: 1, limit: 50 });
  const details = await Promise.all([5, 6, 7].map(id => service.get(owner, id)));
  const expected = new Map([[5, '34.41'], [6, '30.31'], [7, '85.51']]);
  for (const l of details) {
    assert.equal(l.resultado?.pontuacao, expected.get(l.id));
    assert.equal(l.resultado.estadoPontuacao, 'PARCIAL');
    assert.equal(l.resultado.revisao, '2');
    assert.equal(l.resultado.contribuicoes.length, 12);
    assert.ok(l.resultado.substituicoes.every(s => s.regra === 'COMUM'));
    assert.ok(l.resultado.atletas.every(a => !a.utilizadoComoMago));
    assert.equal(list.items.find(i => i.id === l.id).resultado.pontuacao, expected.get(l.id));
  }
  const [five, six, seven] = details;
  assert.deepEqual(five.resultado.substituicoes.map(s => [s.titularSaiuId, s.reservaEntrouId, s.multiplicador, s.pontuacaoContabilizada]),
    [[494, 172, 2, '0'], [246, 704, 1, '3.2'], [147, 502, 1, '2.6']]);
  assert.equal(five.resultado.atletas.find(a => a.catalogoAtletaId === 172).pontuacaoOficial, '-0.2');
  assert.equal(six.resultado.atletas.find(a => a.capitaoEfetivo).pontuacaoContabilizada, '1');
  assert.equal(seven.resultado.atletas.find(a => a.capitaoEfetivo).pontuacaoContabilizada, '5');
  const rankingService = new PointFantasyService(db, {});
  const ranking = await rankingService.ranking(1, { page: 1, limit: 50 }, owner);
  assert.deepEqual(ranking.items.map(i => [i.escalacaoId, i.pontuacao, i.posicao]), [[7, '85.51', 1], [5, '34.41', 2], [6, '30.31', 3]]);
  assert.equal(serialize(await rankingService.ranking(1, { page: 1, limit: 50 }, owner)), serialize(ranking));
  const after = await snapshot(); assert.equal(after, before, 'Database changed during verification');
  fs.writeFileSync('docs/point-fantasy-results-4b-examples.json', JSON.stringify({
    verifiedAt: new Date().toISOString(), database: identity.name, unchangedFingerprint: before,
    meusTimes: list, escalacao5: five, outrasEscalacoes: [six, seven], ranking,
  }, null, 2) + '\n');
  console.log(serialize({ database: identity.name, unchanged: true, totals: details.map(l => [l.id, l.resultado.pontuacao]), ranking: ranking.items }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
