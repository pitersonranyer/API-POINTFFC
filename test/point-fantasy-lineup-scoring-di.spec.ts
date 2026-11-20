import { Test } from '@nestjs/testing';
import { CartolaService } from '../src/cartola/cartola.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';
import { LineupScoringService } from '../src/point-fantasy/scoring/lineup-scoring.service';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';

describe('Point Fantasy scoring dependency injection', () => {
  it('injects Prisma, Cartola and scored-athlete cache into the ranking preview', async () => {
    const prisma = {} as PrismaService;
    const cartola = {} as CartolaService;
    const scoredAthletesCache = {} as ScoredAthletesCacheService;

    const module = await Test.createTestingModule({
      providers: [
        PointFantasyService,
        LineupScoringService,
        { provide: PrismaService, useValue: prisma },
        { provide: CartolaService, useValue: cartola },
        { provide: ScoredAthletesCacheService, useValue: scoredAthletesCache },
      ],
    }).compile();

    const ranking = module.get(PointFantasyService) as any;
    const preview = ranking.lineupScoring as LineupScoringService & any;

    expect(preview).toBeInstanceOf(LineupScoringService);
    expect(preview.db).toBe(prisma);
    expect(preview.cartola).toBe(cartola);
    expect(preview.scoredAthletesCache).toBe(scoredAthletesCache);
  });

  it('returns preview scores through the ranking service when all competition matches ended', async () => {
    const entries = [18, 19, 20, 21].map((id, index) => ({
      id, competicaoId: 7, usuarioId: id, versao: 1, nomePublico: `Escalacao ${id}`,
      sequencial: index + 1, formacao: '4-3-3', identidade: null, usuario: { fantasyBrasaoId: null }, resultado: null,
    }));
    const competition = {
      id: 7, temporada: 2026, rodada: 35, status: 'PUBLICADA', fimInscricao: new Date(0),
      fechamentoDefinitivoEm: null,
      partidas: [{ status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date(0) }],
    };
    const db = {
      fantasyCompeticao: { findFirst: jest.fn(async () => competition) },
      fantasyEscalacao: { findMany: jest.fn(async () => entries), count: jest.fn(async () => entries.length) },
      fantasyApuracaoRodada: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (action: (tx: any) => unknown) => action(db)),
    } as unknown as PrismaService;
    const cartola = { getMarketStatus: jest.fn(async () => { throw new Error('not used in this ranking branch'); }) } as unknown as CartolaService;
    const scoredAthletesCache = {} as ScoredAthletesCacheService;

    const module = await Test.createTestingModule({
      providers: [
        PointFantasyService,
        LineupScoringService,
        { provide: PrismaService, useValue: db },
        { provide: CartolaService, useValue: cartola },
        { provide: ScoredAthletesCacheService, useValue: scoredAthletesCache },
      ],
    }).compile();

    const ranking = module.get(PointFantasyService);
    const preview = module.get(LineupScoringService);
    jest.spyOn(preview, 'previewCartolaCompetition').mockResolvedValue({
      partidas: ['ENCERRADA'], cacheDesatualizado: false,
      items: entries.map((entry, index) => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao,
        total: String(10 + index), missing: [], estado: 'PROVISORIO' as const })),
    } as any);

    const response = await ranking.ranking(7, { page: 1, limit: 50 });

    expect(response.estadoPontuacao).toBe('PROVISORIO');
    expect(response.items.map(item => [item.escalacaoId, item.posicao, item.pontuacao])).toEqual([
      [21, 1, '13'], [20, 2, '12'], [19, 3, '11'], [18, 4, '10'],
    ]);
  });
});
