import { Prisma } from '@prisma/client';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';

describe('3C result ranking visibility (mocks only)', () => {
  let db: any, competition: any, entries: any[], round: any, service: PointFantasyService;
  beforeEach(() => {
    competition = { id: 8, temporada: 2026, rodada: 31, status: 'PUBLICADA',
      fechamentoDefinitivoEm: new Date(1000), partidas: [] };
    round = { revisaoAtual: 1n, hashConteudoAtual: 'a'.repeat(64) };
    entries = [3, 1, 2].map(id => ({ id, usuarioId: id, versao: 2, formacao: '4-3-3', nomePublico: `Time ${id}`,
      identidade: null, sequencial: id, atletas: 'private', capitaoAtletaId: 999,
      resultado: { competicaoId: 8, temporada: 2026, rodada: 31, revisao: 1n,
        hashFonte: round.hashConteudoAtual, versaoEscalacao: 2, versaoMotor: '3F-1',
        total: new Prisma.Decimal(id === 3 ? '5' : '10'), auditoria: { private: true } } }));
    db = {
      fantasyCompeticao: { findFirst: jest.fn(async () => competition) },
      fantasyApuracaoRodada: { findUnique: jest.fn(async () => round) },
      fantasyEscalacao: { findMany: jest.fn(async () => entries), count: jest.fn(async () => 3) },
    };
    db.$transaction = jest.fn(async action => action(db));
    service = new PointFantasyService(db, {} as any);
  });
  it('ranks globally before pagination; ties have the same position', async () => {
    const result = await service.ranking(8, { page: 1, limit: 2 }, 2);
    expect(result.estadoPontuacao).toBe('PARCIAL');
    expect(result.items.map(i => [i.escalacaoId, i.posicao, i.pontuacao, i.meuTime])).toEqual([[1, 1, '10', false], [2, 1, '10', true]]);
    expect((await service.ranking(8, { page: 2, limit: 2 })).items[0].posicao).toBe(3);
    expect(JSON.stringify(result)).not.toMatch(/private|auditoria|atletas|usuarioId|capitaoAtletaId/);
  });
  it.each(['revision', 'lineup', 'competition', 'round', 'season', 'hash', 'missing'])('hides stale or incomplete ranking: %s', async reason => {
    if (reason === 'revision') round.revisaoAtual = 2n;
    if (reason === 'lineup') entries[0].versao++;
    if (reason === 'competition') entries[0].resultado.competicaoId = 9;
    if (reason === 'round') entries[0].resultado.rodada = 32;
    if (reason === 'season') entries[0].resultado.temporada = 2025;
    if (reason === 'hash') entries[0].resultado.hashFonte = 'b'.repeat(64);
    if (reason === 'missing') entries[0].resultado.total = null;
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('INDISPONIVEL');
    expect(result.items.every(i => i.pontuacao === null && i.posicao === null)).toBe(true);
  });
  it('never reads results before definitive closure', async () => {
    competition.fechamentoDefinitivoEm = new Date(Date.now() + 100000);
    await service.ranking(8, { page: 1, limit: 50 });
    expect(db.fantasyApuracaoRodada.findUnique).not.toHaveBeenCalled();
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ id: true }),
    }));
  });
});
