// Phase 3B.3.3A.2: isolated schemas only. No HTTP, bootstrap, DDL or legacy writes.
const { PrismaClient } = require('@prisma/client');
const { createHash } = require('crypto');
const maintenance = require('./point-fantasy-local-maintenance.cjs');
const isolatedName = /^point_fantasy_observation_3b2_test_\d+$/;
function isolatedUrl(value) {
  const url = new URL(value);
  if (process.env.NODE_ENV === 'production' || url.protocol !== 'mysql:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !isolatedName.test(decodeURIComponent(url.pathname.slice(1)))) throw new Error('ISOLATED_LOCAL_SCHEMA_REQUIRED');
  return url.toString();
}
const fields = ['CLUBE_ID_CARTOLA', 'POSICAO_ID', 'ESTADO_CLUBE', 'ESTADO_POSICAO', 'PONTUACAO',
  'PONTUACAO_TOKEN_ORIGINAL', 'ESTADO_PONTUACAO', 'ENTROU_EM_CAMPO', 'ESTADO_PARTICIPACAO',
  'PARTICIPACAO_OBSERVADA', 'SCOUTS', 'ESTADO_SCOUTS', 'HASH_CONTEUDO'];

// Null-safe SQL comparison keeps DECIMAL inside MySQL. JSON comparison is semantic.
async function verify(tx, round, snapshotId, collectionId) {
  const predicate = fields.map(f => `(p.${f} <=> a.${f})`).join(' AND ');
  const rows = await tx.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM FANTASY_PONTUACAO_ATLETA p
    JOIN FANTASY_PONTUACAO_ATLETA_SNAPSHOT a ON a.SNAPSHOT_ID=? AND a.ATLETA_ID_CARTOLA=p.ATLETA_ID_CARTOLA
    JOIN FANTASY_PONTUACAO_SNAPSHOT s ON s.ID=a.SNAPSHOT_ID
    WHERE p.APURACAO_ID=? AND p.TEMPORADA=? AND p.RODADA=? AND p.COLETA_ALTERACAO_ID=?
      AND p.REVISAO_ALTERACAO=1 AND p.PRESENTE_NA_ULTIMA_LISTA=1
      AND p.VERSAO_NORMALIZADOR=s.VERSAO_NORMALIZADOR AND ${predicate}`,
  snapshotId, round.ID, round.TEMPORADA, round.RODADA, collectionId);
  const expected = await tx.$queryRaw`SELECT COUNT(*) AS n FROM FANTASY_PONTUACAO_ATLETA_SNAPSHOT WHERE SNAPSHOT_ID=${snapshotId}`;
  const actual = await tx.$queryRaw`SELECT COUNT(*) AS n FROM FANTASY_PONTUACAO_ATLETA WHERE APURACAO_ID=${round.ID}`;
  if (rows[0].n !== expected[0].n || actual[0].n !== expected[0].n) throw new Error('BACKFILL_INTEGRITY_MISMATCH');
  const totals = await tx.$queryRaw`SELECT CAST(SUM(PONTUACAO) AS CHAR) AS soma, COUNT(*) AS total,
    SUM(POSICAO_ID=6) AS tecnicos FROM FANTASY_PONTUACAO_ATLETA WHERE APURACAO_ID=${round.ID}`;
  return totals[0];
}
function backfillOperationId(temporada, rodada) {
  const hex = createHash('sha256').update(`point-fantasy-backfill-v1:${temporada}:${rodada}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}
async function backfill(value, temporada, rodada, localAuthorization) {
  const url = localAuthorization ? maintenance.destination(value).toString() : isolatedUrl(value);
  if (!Number.isInteger(temporada) || temporada < 2000 || temporada > 65535
    || !Number.isInteger(rodada) || rodada < 1 || rodada > 38) throw new Error('INVALID_IDENTITY');
  const localRequest = localAuthorization ? maintenance.boundBackfillRequest(localAuthorization, temporada, rodada, backfillOperationId(temporada,rodada)) : null;
  const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    return await db.$transaction(async tx => {
      if (localAuthorization) await maintenance.assertMaintenance(tx, localAuthorization, url, localRequest, 'BACKFILL');
      const identity = await tx.$queryRaw`SELECT DATABASE() AS name`;
      if (localAuthorization ? identity[0].name !== 'fantasy_point_do_jogador' : !isolatedName.test(identity[0].name)) throw new Error('ISOLATED_LOCAL_SCHEMA_REQUIRED');
      const rounds = await tx.$queryRaw`SELECT * FROM FANTASY_APURACAO_RODADA
        WHERE TEMPORADA=${temporada} AND RODADA=${rodada} FOR UPDATE`;
      const round = rounds[0];
      if (!round || round.ESTADO !== 'OBSERVANDO' || round.LOCK_TOKEN !== null) throw new Error('QUIESCENT_OBSERVING_ROUND_REQUIRED');
      const pending = await tx.fantasyPontuacaoColeta.count({ where: { rodadaId: Number(round.ID), estado: 'EM_ANDAMENTO' } });
      if (pending) throw new Error('IN_PROGRESS_COLLECTION');
      // Fence orders accepted legacy operations, including A -> B -> A snapshot reuse.
      const sources = await tx.$queryRaw`SELECT c.ID AS COLETA_ID, s.* FROM FANTASY_PONTUACAO_COLETA c
        JOIN FANTASY_PONTUACAO_SNAPSHOT s ON s.ID=c.SNAPSHOT_ID AND s.RODADA_ID=c.RODADA_ID
        WHERE c.RODADA_ID=${round.ID} AND c.ESTADO='SUCESSO' AND c.MODELO_PERSISTENCIA='SNAPSHOT_LEGADO'
        ORDER BY c.FENCE DESC, c.CONCLUIDA_EM DESC, c.ID DESC LIMIT 1`;
      const source = sources[0];
      if (!source) throw new Error('ACCEPTED_LEGACY_SNAPSHOT_REQUIRED');
      const operation = backfillOperationId(temporada,rodada);
      const reason = `BACKFILL_V1 snapshot=${source.ID} coletaLegada=${source.COLETA_ID}`;
      const previous = await tx.fantasyPontuacaoColeta.findUnique({ where: { operacaoId: operation } });
      if (previous) {
        if (previous.rodadaId !== Number(round.ID) || previous.motivo !== reason || previous.estado !== 'SUCESSO'
          || previous.modeloPersistencia !== 'ATUAL' || previous.revisaoBase !== 0n || previous.revisaoResultante !== 1n
          || previous.resultadoAplicacao !== 'APLICADA' || round.REVISAO_ATUAL !== 1n
          || Number(round.ULTIMA_COLETA_APLICADA_ID) !== previous.id || round.HASH_CONTEUDO_ATUAL !== source.HASH_CONTEUDO
          || round.VERSAO_NORMALIZADOR !== source.VERSAO_NORMALIZADOR) throw new Error('BACKFILL_BASE_CHANGED');
        return { reused: true, coletaId: previous.id, snapshotId: Number(source.ID), ...await verify(tx, round, source.ID, previous.id) };
      }
      if (round.REVISAO_ATUAL !== 0n || await tx.fantasyPontuacaoAtleta.count({ where: { apuracaoId: Number(round.ID) } })) {
        throw new Error('EMPTY_CURRENT_MODEL_REQUIRED');
      }
      const count = await tx.fantasyPontuacaoAtletaSnapshot.count({ where: { snapshotId: Number(source.ID) } });
      const audit = await tx.fantasyPontuacaoColeta.create({ data: {
        operacaoId: operation, rodadaId: Number(round.ID), endpoint: 'LOCAL_BACKFILL', modeloPersistencia: 'ATUAL',
        estado: 'SUCESSO', concluidaEm: new Date(), recebidaEm: source.COLETADO_EM,
        revisaoBase: 0n, revisaoResultante: 1n, hashConteudo: source.HASH_CONTEUDO,
        versaoNormalizador: source.VERSAO_NORMALIZADOR, fonte: source.FONTE, resultadoAplicacao: 'APLICADA',
        qtdRecebidos: count, qtdInseridos: count, qtdAlterados: 0, qtdOmitidos: 0, motivo: reason,
        alteracoes: { origem: 'BACKFILL_V1', snapshotLegadoId: String(source.ID), coletaLegadaId: String(source.COLETA_ID) },
        limitacoes: ['LOCAL_BACKFILL_NO_HTTP', 'FINAL_COMPLETENESS_NOT_PROVEN'], fence: round.FENCE,
      } });
      // Copy values directly: no decimal parsing, rounding or JavaScript Number conversion.
      await tx.$executeRawUnsafe(`INSERT INTO FANTASY_PONTUACAO_ATLETA
        (TEMPORADA,RODADA,ATLETA_ID_CARTOLA,APURACAO_ID,${fields.join(',')},PRESENTE_NA_ULTIMA_LISTA,
         VERSAO_NORMALIZADOR,REVISAO_ALTERACAO,COLETA_ALTERACAO_ID,CRIADO_EM,ALTERADO_EM)
        SELECT ?,?,a.ATLETA_ID_CARTOLA,?,${fields.map(f => 'a.' + f).join(',')},1,?,1,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)
        FROM FANTASY_PONTUACAO_ATLETA_SNAPSHOT a WHERE a.SNAPSHOT_ID=?`,
      temporada, rodada, round.ID, source.VERSAO_NORMALIZADOR, audit.id, source.ID);
      await tx.fantasyApuracaoRodada.update({ where: { id: Number(round.ID) }, data: {
        revisaoAtual: 1n, hashConteudoAtual: source.HASH_CONTEUDO,
        versaoNormalizador: source.VERSAO_NORMALIZADOR, ultimaColetaAplicadaId: audit.id,
      } });
      return { reused: false, coletaId: audit.id, snapshotId: Number(source.ID), ...await verify(tx, round, source.ID, audit.id) };
    }, { isolationLevel: 'Serializable', timeout: 30000 });
  } finally { await db.$disconnect(); }
}
if (require.main === module) {
  // Deliberately no DATABASE_URL fallback: principal cannot be selected accidentally.
  const [, , season, round] = process.argv;
  backfill(process.env.POINT_FANTASY_SCORING_TEST_DATABASE_URL, Number(season), Number(round))
    .then(result => console.log(JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v)))
    .catch(error => { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'BACKFILL_FAILED'); process.exitCode = 1; });
}
module.exports = { backfill, isolatedUrl, backfillOperationId };
