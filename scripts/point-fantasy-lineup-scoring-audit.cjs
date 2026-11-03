// Read-only audit. No imports of collectors, schedulers or migration runners.
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { PrismaClient } = require('@prisma/client');
const { validateSelection } = require('../src/point-fantasy/lineups/lineup.rules');
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  if (process.env.NODE_ENV === 'production' || url.protocol !== 'mysql:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || decodeURIComponent(url.pathname.slice(1)) !== 'fantasy_point_do_jogador') throw Error('LOCAL_DATABASE_REQUIRED');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  try {
    return await db.$transaction(async tx => {
      const [identity] = await tx.$queryRaw`SELECT DATABASE() AS name`;
      if (identity.name !== 'fantasy_point_do_jogador') throw Error('LOCAL_DATABASE_REQUIRED');
      const tables = await tx.$queryRaw`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME LIKE 'FANTASY_%' OR TABLE_NAME IN ('TIME_RODADA','PONTUACAO_TIME_RODADA','SUBSTITUICAO_TIME_RODADA')) ORDER BY TABLE_NAME`;
      const competitions = await tx.fantasyCompeticao.findMany({ where: { temporada: 2026, rodada: 31 },
        include: { catalogo: true, partidas: true, escalacoes: { include: { atletas: { include: { atleta: true } } } } }, orderBy: { id: 'asc' } });
      const report = competitions.map(c => {
        const clubs = new Set(c.partidas.flatMap(m => [m.clubeMandanteId, m.clubeVisitanteId]));
        const confirmed = c.escalacoes.filter(l => l.status === 'INSCRITA' && l.confirmadaEm);
        const eligible = confirmed.filter(l => {
          if (c.status !== 'PUBLICADA' || c.catalogo.status !== 'CONGELADO' || !c.partidas.length
            || c.temporada !== c.catalogo.temporada || c.rodada !== c.catalogo.rodada
            || (c.fechamentoDefinitivoEm && l.confirmadaEm > c.fechamentoDefinitivoEm)
            || l.atletas.some(p => p.atleta.catalogoId !== c.catalogoId || !clubs.has(p.atleta.clubeIdExterno))) return false;
          try {
            return validateSelection({ formacao: l.formacao,
              titulares: l.atletas.filter(p => p.papel === 'TITULAR').map(p => p.catalogoAtletaId),
              reservas: l.atletas.filter(p => p.papel === 'RESERVA').map(p => p.catalogoAtletaId),
              tecnico: l.atletas.find(p => p.papel === 'TECNICO')?.catalogoAtletaId ?? null,
              capitaoAtletaId: l.capitaoAtletaId, reservaMagoAtletaId: l.reservaMagoAtletaId,
            }, l.atletas.map(p => p.atleta)).completa;
          } catch { return false; }
        });
        return { id: c.id, nome: c.nome, status: c.status, partidas: c.partidas.length,
          fechamentoDefinitivoEm: c.fechamentoDefinitivoEm, inscritas: c.escalacoes.filter(l => l.status === 'INSCRITA').length,
          confirmadas: confirmed.length, elegiveis: eligible.length,
          prontasParaProcessar: c.fechamentoDefinitivoEm && c.fechamentoDefinitivoEm <= new Date() ? eligible.length : 0 };
      });
      const round = await tx.fantasyApuracaoRodada.findUnique({ where: { temporada_rodada: { temporada: 2026, rodada: 31 } },
        select: { id: true, estado: true, revisaoAtual: true, revisaoValidada: true } });
      const count = await tx.fantasyPontuacaoAtleta.count({ where: { temporada: 2026, rodada: 31 } });
      console.log(JSON.stringify({ database: identity.name, tables: tables.map(t => t.name), round,
        atletasComRegistro: count, competitions: report }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    }, { isolationLevel: 'RepeatableRead' });
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('LOCAL_READ_ONLY_AUDIT_FAILED'); process.exitCode = 1; });
module.exports = { main };
