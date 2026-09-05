import { PrismaClient } from '@prisma/client';
import { CartolaService } from '../src/cartola/cartola.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TimeSnapshotsService } from '../src/time-snapshots/time-snapshots.service';

const describeIntegration = process.env.RUN_MYSQL_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeIntegration('TimeSnapshotsService - integração MySQL', () => {
  const prisma = new PrismaClient();
  const snapshotTimeId = 2_147_483_001;
  const rollbackTimeId = 2_147_483_002;
  const temporada = 65_000;
  const rodada = 38;

  const cartola = {
    loadMarketStatusFresh: jest.fn(async () => ({ temporada, rodada_atual: rodada, status_mercado: 2 })),
    getTeamById: jest.fn(async (timeId: number) => ({
      value: {
        time: { time_id: timeId, nome: `Time integração ${timeId}` },
        atletas: [{ atleta_id: 2_147_483_003, posicao_id: 5, clube_id: 1 }],
        reservas: [{ atleta_id: 2_147_483_004, posicao_id: 5, clube_id: 2 }],
        capitao_id: 2_147_483_003,
        reserva_luxo_id: 2_147_483_004,
      },
      cache: 'miss' as const,
      stale: false,
    })),
  };
  const service = new TimeSnapshotsService(
    cartola as unknown as CartolaService,
    prisma as unknown as PrismaService,
  );

  beforeAll(() => prisma.$connect());

  afterEach(async () => {
    await prisma.timeRodada.deleteMany({ where: { timeId: { in: [snapshotTimeId, rollbackTimeId] }, temporada } });
    await prisma.timeCartola.deleteMany({ where: { timeId: { in: [snapshotTimeId, rollbackTimeId] } } });
  });

  afterAll(() => prisma.$disconnect());

  it('persiste uma única rodada sob duas capturas concorrentes e retorna o mesmo snapshot', async () => {
    const [primeira, segunda] = await Promise.all([
      service.criarSnapshot({ timeId: snapshotTimeId, temporada, rodada }),
      service.criarSnapshot({ timeId: snapshotTimeId, temporada, rodada }),
    ]);

    expect(primeira.timeRodadaId).toBe(segunda.timeRodadaId);
    expect(await prisma.timeRodada.count({ where: { timeId: snapshotTimeId, temporada, rodada } })).toBe(1);
    expect(await prisma.escalacaoTimeRodada.count({ where: { timeRodadaId: primeira.timeRodadaId } })).toBe(2);
    expect(await prisma.timeRodada.findUnique({ where: { id: primeira.timeRodadaId } }))
      .toMatchObject({ reservaLuxoId: 2_147_483_004 });
  });

  it('faz rollback físico quando a escalação falha depois da criação do time e da rodada', async () => {
    cartola.getTeamById.mockResolvedValueOnce({
      value: {
        time: { time_id: rollbackTimeId, nome: 'Time rollback' },
        atletas: [{ atleta_id: 2_147_483_003, posicao_id: 4_294_967_296, clube_id: 1 }],
        reservas: [{ atleta_id: 2_147_483_004, posicao_id: 5, clube_id: 2 }],
        capitao_id: 2_147_483_003,
        reserva_luxo_id: 2_147_483_004,
      },
      cache: 'miss',
      stale: false,
    });

    await expect(service.criarSnapshot({ timeId: rollbackTimeId, temporada, rodada })).rejects.toThrow();
    expect(await prisma.timeCartola.count({ where: { timeId: rollbackTimeId } })).toBe(0);
    expect(await prisma.timeRodada.count({ where: { timeId: rollbackTimeId, temporada, rodada } })).toBe(0);
  });
});
