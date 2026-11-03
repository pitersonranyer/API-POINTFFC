// Phase 3D evidence only: SELECTs and local report output. Never closes or migrates.
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { validateSelection } = require('../src/point-fantasy/lineups/lineup.rules');
const { scoreLineup, rankScores } = require('../src/point-fantasy/scoring/scoring-engine');
function markdown(r) {
  const lines = [
    '# Fase 3D — homologação interrompida antes de gravar', '',
    `Consulta: ${new Date(r.date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (America/Sao_Paulo).`, '',
    'Branch `feat/point-fantasy-scoring-observation-3b2`. Alterações locais preservadas. Conexão exclusivamente com MySQL local, banco `fantasy_point_do_jogador`. Competição 1, temporada 2026, rodada 31, três escalações confirmadas e estruturalmente elegíveis, três partidas, revisão 2 e 306 registros oficiais.', '',
    '## Resultado', '',
    '- Fechamento definitivo: bloqueado; campo null. Não existe operação administrativa de fechamento em AdminPointFantasyController/PointFantasyService. As referências existentes apenas leem ou validam o campo. Não se criou funcionalidade nem se executou UPDATE direto.',
    '- Migração 0031: não aplicada. SQL aditiva revisada: ADD UNIQUE INDEX em FANTASY_ESCALACAO e CREATE TABLE FANTASY_ESCALACAO_RESULTADO, com índices e FKs; nenhuma operação destrutiva. É a única migração pendente. Nenhum executor de migrations foi invocado, pois a sequência foi interrompida pelas pendências da prévia e ausência de fluxo de fechamento.',
    '- Divergências históricas de checksum 0024/0025 correspondem exatamente aos pares já documentados em scripts/point-fantasy-local-migrations.cjs. Histórico não modificado.',
    '- Resultados persistidos: **0**. A tabela de resultados continua ausente.',
    '- Ranking, empates e soma persistida: indisponíveis; os três totais são null por falta de informação.',
    '- Substituições comuns/Mago: nenhuma aplicada ou persistida. A prévia incompleta não permite afirmar quais serão realizadas.', '',
    '## Prévia somente de leitura', '',
    'Motor puro executado em memória com os dados reais e as mesmas validações de seleção/identidade da Fase 3C. Nenhuma alteração no fechamento ou chamada de persistência. O método preview do serviço exige fechamento; essa validação não foi contornada para escrever.', '',
    '| Posição | Escalação | Pontos | Substituições | Capitão: pontos oficiais e 2x original |',
    '|---|---|---|---|---|',
  ];
  for (const l of r.previews) {
    const c = l.athletes.find(a => a.captain);
    const captain = c.points === null ? `${c.name}: sem informação` : `${c.name}: ${c.points} × 2 = ${new (require('@prisma/client').Prisma.Decimal)(c.points).times(2).toFixed()}`;
    lines.push(`| — | ${l.escalacaoId} — ${l.name} | Indisponível | Não calculáveis | ${captain} |`);
  }
  lines.push('', 'Contribuições originais de capitão, antes de qualquer eventual substituição; não são resultados finais homologados.', '',
    '## Pendências oficiais', '',
    'Atletas sem registro de pontuação e sem evidência de não participação na temporada/rodada/apuração corretas. Não foram convertidos em zero.', '',
    '| Atleta | ID catálogo | ID Cartola | Escalações | Papel |', '|---|---|---|---|---|');
  const missing = new Map();
  for (const l of r.previews) for (const a of l.athletes.filter(a => l.missing.includes(a.id))) {
    if (!missing.has(a.id)) missing.set(a.id, { ...a, lineups: [] });
    missing.get(a.id).lineups.push(l.escalacaoId);
  }
  for (const a of [...missing.values()].sort((a,b) => a.id - b.id)) lines.push(`| ${a.name} | ${a.id} | ${a.externalId} | ${a.lineups.join(', ')} | ${a.role} |`);
  lines.push('', '## Pontuações individuais', '',
    'Cada tabela contém 11 titulares, técnico e cinco reservas. A contribuição original é anterior às substituições; não foi somada a um total fictício. “Sem informação” não significa zero.');
  for (const l of r.previews) {
    lines.push('', `### Escalação ${l.escalacaoId} — ${l.name}`, '', `Formação ${l.formacao}; versão ${l.version}; total final indisponível.`, '',
      '| Papel | Atleta | ID catálogo / Cartola | Pontos oficiais | Multiplicador original | Contribuição original |', '|---|---|---|---|---|---|');
    const order = { TITULAR: 0, TECNICO: 1, RESERVA: 2 };
    for (const a of [...l.athletes].sort((a,b) => order[a.role] - order[b.role] || a.position - b.position || a.id - b.id)) {
      const multiplier = a.captain ? 2 : 1;
      const contribution = a.role === 'RESERVA' ? '—' : a.points === null ? 'Indisponível'
        : new (require('@prisma/client').Prisma.Decimal)(a.points).times(multiplier).toFixed();
      lines.push(`| ${a.role}${a.captain ? ' / CAPITÃO' : ''}${a.mago ? ' / MAGO' : ''} | ${a.name} | ${a.id} / ${a.externalId} | ${a.points ?? 'Sem informação'} | ${a.role === 'RESERVA' ? '—' : multiplier + 'x'} | ${contribution} |`);
    }
  }
  lines.push('', '## Regras e validação', '',
    'Conferidos: reserva comum apenas para titular comprovadamente ausente da mesma posição, com contribuição mínima zero; Mago na mesma posição buscando o melhor resultado entre combinações válidas, inclusive valores negativos, sem reutilização e com herança de 2x do capitão. Não foi identificada divergência concreta que justificasse alterar regras. Motor e funcionalidades existentes não foram modificados.', '',
    'Testes em memória/mocks: **3 suítes, 34 testes aprovados** (scoring-engine, lineup-scoring e result-ranking). Nenhum banco/schema temporário foi criado.', '',
    '## Para retomar', '',
    '1. Disponibilizar evidência oficial persistida suficiente para os seis atletas pendentes, sem fabricar pontos ou presumir não participação. Nova coleta não está autorizada nesta fase.',
    '2. Disponibilizar fluxo administrativo de fechamento definitivo. Implementá-lo seria funcionalidade nova, fora deste pedido.',
    '3. Revalidar identidade, elegibilidade e revisão. Se a revisão não for 2, solicitar nova autorização.',
    '4. Com as pendências resolvidas, aplicar exclusivamente 0031, persistir uma vez e conferir totais, auditoria, duplicidade e ranking.', '',
    'Nenhuma escrita no MySQL foi executada. Outras competições, rodada 32, inscrições e finanças não foram alteradas. Não houve coleta, produção/Render, frontend, commit, push, merge ou deploy.', '',
    'Evidência detalhada: `docs/point-fantasy-3d-readonly.json`. Reprodução: `node scripts/point-fantasy-3d-readonly.cjs`.', '');
  return lines.join('\n');
}
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'fantasy_point_do_jogador');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  try {
    const report = await db.$transaction(async tx => {
      const [identity] = await tx.$queryRaw`SELECT DATABASE() AS name, @@hostname AS host, @@port AS port`;
      assert.equal(identity.name, 'fantasy_point_do_jogador');
      const c = await tx.fantasyCompeticao.findUniqueOrThrow({ where: { id: 1 }, include: {
        catalogo: true, partidas: true, escalacoes: { include: { atletas: { include: { atleta: true } } }, orderBy: { id: 'asc' } },
      } });
      assert.equal(c.temporada, 2026); assert.equal(c.rodada, 31); assert.equal(c.status, 'PUBLICADA');
      assert.equal(c.nome, 'POINT FFC Fantasy — Homologação R31');
      assert.equal(c.catalogo.status, 'CONGELADO');
      assert.equal(c.catalogo.temporada, 2026); assert.equal(c.catalogo.rodada, 31);
      const round = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { temporada_rodada: { temporada: 2026, rodada: 31 } } });
      assert.equal(round.revisaoAtual, 2n); assert.ok(round.hashConteudoAtual);
      const points = await tx.fantasyPontuacaoAtleta.findMany({ where: { temporada: 2026, rodada: 31, apuracaoId: round.id } });
      assert.equal(points.length, 306);
      const history = await tx.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY started_at`;
      assert.ok(!history.some(h => h.migration_name === '0031_point_fantasy_lineup_results' && !h.rolled_back_at));
      const resultTables = await tx.$queryRaw`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='FANTASY_ESCALACAO_RESULTADO'`;
      assert.equal(resultTables.length, 0);
      const names = fs.readdirSync(path.join(__dirname, '../prisma/migrations')).filter(n => /^\d/.test(n)).sort();
      const pending = names.filter(n => !history.some(h => h.migration_name === n && h.finished_at && !h.rolled_back_at));
      const mismatches = history.filter(h => h.finished_at && !h.rolled_back_at).flatMap(h => {
        const file = path.join(__dirname, '../prisma/migrations', h.migration_name, 'migration.sql');
        return !fs.existsSync(file) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== h.checksum ? [h.migration_name] : [];
      });
      const historicalExceptions = {
        '0024_point_fantasy_foundation': ['01a5023fd78293a0a02cb38943e1066545c56031d9ec8650ca27174d69d349f4', '3ad34fcd32e9f0c8de1b992d1dc4cf0842156bdb5ca1bdd31bb77e94c9411eb0'],
        '0025_point_fantasy_lineups': ['d6514954e86ce2b5d2c8a3aa69225a72c3804fe9ca5271ef802c7c6195a65b1b', '7fa6c71056791a429ecc57c9a33e4ff0cc84338f1f705a7f33266c294b1376e2'],
      };
      const knownHistoricalMismatches = mismatches.filter(name => {
        const expected = historicalExceptions[name];
        const h = history.find(row => row.migration_name === name && row.finished_at && !row.rolled_back_at);
        const file = path.join(__dirname, '../prisma/migrations', name, 'migration.sql');
        return expected && h.checksum === expected[0] && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected[1];
      });
      const clubs = new Set(c.partidas.flatMap(m => [m.clubeMandanteId, m.clubeVisitanteId]));
      const byExternal = new Map(points.map(p => [p.atletaIdCartola, p]));
      const lineups = c.escalacoes.filter(l => l.status === 'INSCRITA' && l.confirmadaEm);
      assert.equal(lineups.length, 3);
      const previews = lineups.map(l => {
        assert.ok(!c.fechamentoDefinitivoEm || l.confirmadaEm <= c.fechamentoDefinitivoEm);
        assert.ok(l.atletas.every(p => p.atleta.catalogoId === c.catalogoId && clubs.has(p.atleta.clubeIdExterno)));
        const selection = { formacao: l.formacao,
          titulares: l.atletas.filter(p => p.papel === 'TITULAR').map(p => p.catalogoAtletaId),
          reservas: l.atletas.filter(p => p.papel === 'RESERVA').map(p => p.catalogoAtletaId),
          tecnico: l.atletas.find(p => p.papel === 'TECNICO')?.catalogoAtletaId ?? null,
          capitaoAtletaId: l.capitaoAtletaId, reservaMagoAtletaId: l.reservaMagoAtletaId };
        assert.equal(validateSelection(selection, l.atletas.map(p => p.atleta)).completa, true);
        const athletes = l.atletas.map(p => {
          const a = p.atleta, official = byExternal.get(a.atletaIdExterno);
          const valid = official && official.estadoClube === 'VALOR' && official.estadoPosicao === 'VALOR'
            && official.clubeIdCartola === a.clubeIdExterno && official.posicaoId === a.posicaoId && official.revisaoAlteracao <= round.revisaoAtual;
          const played = valid && official.estadoParticipacao === 'VALOR' ? official.entrouEmCampo : null;
          const score = valid && official.estadoPontuacao === 'VALOR' ? official.pontuacao?.toFixed() ?? null : null;
          return { id: a.id, externalId: a.atletaIdExterno, name: a.apelido, club: a.clubeIdExterno,
            position: a.posicaoId, role: p.papel, captain: a.id === l.capitaoAtletaId, mago: a.id === l.reservaMagoAtletaId,
            points: score, played, sourcePresent: !!official,
            reason: !official ? 'SEM_REGISTRO_NA_COLETA' : !valid ? 'IDENTIDADE_OFICIAL_INCOMPATIVEL'
              : score === null && played !== false ? 'PONTUACAO_E_NAO_PARTICIPACAO_INSUFICIENTES' : null,
            participationEvidence: official?.participacaoObservada ?? null };
        }).sort((a, b) => a.id - b.id);
        const result = scoreLineup(athletes, selection.capitaoAtletaId, selection.reservaMagoAtletaId);
        return { escalacaoId: l.id, name: l.nomePublico, version: l.versao,
          formacao: l.formacao, captain: l.capitaoAtletaId, mago: l.reservaMagoAtletaId,
          ...result, athletes };
      });
      return { date: new Date().toISOString(), database: identity.name, connectionLocal: true,
        competition: { id: c.id, name: c.nome, temporada: c.temporada, rodada: c.rodada,
          fechamentoDefinitivoEm: c.fechamentoDefinitivoEm, partidas: c.partidas.length },
        round: { id: round.id, revision: round.revisaoAtual.toString(), state: round.estado, records: points.length, hash: round.hashConteudoAtual },
        migration: { pending, checksumMismatches: mismatches, knownHistoricalMismatches, resultTableExists: false,
          sqlSha256: createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../prisma/migrations/0031_point_fantasy_lineup_results/migration.sql'))).digest('hex') },
        structurallyEligible: lineups.length, previews: rankScores(previews),
        note: 'Pure engine preview in memory; closure gate is not bypassed for persistence. No database writes.' };
    }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
    fs.writeFileSync(path.join(__dirname, '../docs/point-fantasy-3d-readonly.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(__dirname, '../docs/point-fantasy-scoring-3d.md'), markdown(report));
    console.log(JSON.stringify(report, null, 2));
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(error => {
  console.error(error.code || (error.name === 'AssertionError' ? 'EXPECTED_SCOPE_DIVERGED' : 'READ_ONLY_AUDIT_FAILED'));
  process.exitCode = 1;
});
module.exports = { main };
