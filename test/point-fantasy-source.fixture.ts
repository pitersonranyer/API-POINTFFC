import { Prisma } from '@prisma/client';
import { stableJson } from '../src/point-fantasy/observation/current-scoring-plan';
import { sha256 } from '../src/point-fantasy/observation/official-normalizer';
import { completeLineup } from './point-fantasy-lineup.fixture';
export function completeSource() {
  const { athletes } = completeLineup();
  const points: any[] = athletes.map(a => ({ atletaIdCartola: a.atletaIdExterno, clubeIdCartola: 263,
    posicaoId: a.posicaoId, temporada: 2026, rodada: 31, apuracaoId: 2,
    estadoClube: 'VALOR', estadoPosicao: 'VALOR', estadoPontuacao: 'VALOR', estadoParticipacao: 'VALOR',
    pontuacao: new Prisma.Decimal(1), entrouEmCampo: true, revisaoAlteracao: 2n,
    hashConteudo: 'c'.repeat(64), presenteNaUltimaLista: true, versaoNormalizador: 'v1' }));
  const round: any = { id: 2, temporada: 2026, rodada: 31, revisaoAtual: 2n, ultimaColetaAplicadaId: 8 };
  const matches: any[] = [{ partidaIdExterno: 10, clubeMandanteId: 263, clubeVisitanteId: 264 }];
  const collection: any = { id: 8, rodadaId: 2, estado: 'SUCESSO', modeloPersistencia: 'ATUAL', revisaoResultante: 2n,
    hashPayload: 'd'.repeat(64), limitacoes: { modalidade: 'PARCIAL' } };
  function rehash() {
    round.hashConteudoAtual = sha256(stableJson({ schema: 'current-scoring-v1', temporada: 2026, rodada: 31,
      atletas: [...points].sort((a,b) => a.atletaIdCartola - b.atletaIdCartola)
        .map(a => [a.atletaIdCartola, a.hashConteudo, a.presenteNaUltimaLista, a.versaoNormalizador]) }));
    collection.hashConteudo = round.hashConteudoAtual; collection.qtdRecebidos = points.filter(p => p.presenteNaUltimaLista).length;
  }
  rehash();
  const legacyPayload = { rodada: 31, total_atletas: athletes.length - 1, atletas: Object.fromEntries(athletes.slice(1).map(a =>
    [a.atletaIdExterno, { pontuacao: 1, entrou_em_campo: true, clube_id: a.clubeIdExterno, posicao_id: a.posicaoId }])) };
  const legacyMatches = { rodada: 31, partidas: [
    { partida_id: 10, clube_casa_id: 263, clube_visitante_id: 264, valida: true, periodo_tr: 'POS_JOGO', partida_data: '2026-10-01 18:00:00' },
    { partida_id: 20, clube_casa_id: 265, clube_visitante_id: 266, valida: true, periodo_tr: 'PRE_JOGO', partida_data: '2026-10-01 20:00:00' },
  ] };
  const context = { text: JSON.stringify({ temporada: 2026, rodada_atual: 31, status_mercado: 2 }) };
  const legacy: any = { id: 3, rodadaId: 2, estado: 'SUCESSO', snapshotId: 1, httpStatus: 200,
    statusAntes: context, statusDepois: context, snapshot: { id: 1, rodadaId: 2 },
    evidenciasPartidas: { status: 200, error: null, endpoint: '/partidas/31' } };
  function syncLegacy() {
    legacy.snapshot.payloadOriginal = JSON.stringify(legacyPayload);
    legacy.payloadRecebido = legacy.snapshot.payloadOriginal;
    legacy.snapshot.hashPayload = sha256(legacy.snapshot.payloadOriginal);
    legacy.hashPayload = legacy.snapshot.hashPayload;
    legacy.evidenciasPartidas.text = JSON.stringify(legacyMatches);
  }
  syncLegacy();
  return { round, collection, points, matches, athletes, rehash, legacy, legacyPayload, legacyMatches, syncLegacy };
}
