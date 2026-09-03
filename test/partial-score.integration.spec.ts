import { Prisma, PrismaClient } from '@prisma/client';
import { PartialScoreService } from '../src/partial-score/partial-score.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';

const describeIntegration = process.env.RUN_MYSQL_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeIntegration('PartialScoreService - integração MySQL', () => {
  const prisma = new PrismaClient();
  const timeId = 2_147_483_010;
  const temporada = 65_000;
  const rodada = 37;
  const scoredCache = { getScoredAthletes: jest.fn() };
  const service = new PartialScoreService(
    prisma as unknown as PrismaService,
    scoredCache as unknown as ScoredAthletesCacheService,
  );

  beforeAll(() => prisma.$connect());

  beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.timeRodada.deleteMany({ where: { timeId, temporada } });
    await prisma.timeCartola.deleteMany({ where: { timeId } });
    await prisma.timeCartola.create({ data: { timeId, nomeTime: 'Time integração parcial' } });
    const timeRodada = await prisma.timeRodada.create({ data: { timeId, temporada, rodada, capitaoId: 2_147_483_012 } });
    await prisma.escalacaoTimeRodada.createMany({ data: [
      { timeRodadaId: timeRodada.id, atletaId: 2_147_483_011, posicaoId: 5, titular: true, reserva: false, capitao: false },
      { timeRodadaId: timeRodada.id, atletaId: 2_147_483_012, posicaoId: 6, titular: true, reserva: false, capitao: true },
      { timeRodadaId: timeRodada.id, atletaId: 2_147_483_013, posicaoId: 5, titular: false, reserva: true, capitao: false },
    ] });
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada, atletas: {
        '2147483011': { pontuacao: 1.1 },
        '2147483012': { pontuacao: 2.2 },
        '2147483013': { pontuacao: 100 },
      } },
      cache: 'miss', stale: false,
    });
  });

  afterEach(async () => {
    await prisma.timeRodada.deleteMany({ where: { timeId, temporada } });
    await prisma.timeCartola.deleteMany({ where: { timeId } });
  });

  afterAll(() => prisma.$disconnect());

  it('persiste uma única pontuação e atualiza a mesma linha em novo cálculo', async () => {
    const primeira = await service.calcular({ timeId, temporada, rodada });
    expect(primeira.pontuacaoParcial).toBe(4.4);

    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada, atletas: {
        '2147483011': { pontuacao: 3.25 },
        '2147483012': { pontuacao: -1.5 },
      } },
      cache: 'miss', stale: false,
    });
    const segunda = await service.calcular({ timeId, temporada, rodada });
    const timeRodada = await prisma.timeRodada.findUniqueOrThrow({
      where: { timeId_temporada_rodada: { timeId, temporada, rodada } },
      include: { pontuacao: true },
    });

    expect(segunda.pontuacaoParcial).toBe(1);
    expect(timeRodada.pontuacao?.pontuacao.toNumber()).toBe(1);
    expect(timeRodada.pontuacao?.status).toBe('PARCIAL');
    expect(await prisma.pontuacaoTimeRodada.count({ where: { timeRodadaId: timeRodada.id } })).toBe(1);
  });

  it('mantém uma única linha e conclui duas chamadas simultâneas com sucesso', async () => {
    const [primeira, segunda] = await Promise.all([
      service.calcular({ timeId, temporada, rodada }),
      service.calcular({ timeId, temporada, rodada }),
    ]);
    const timeRodada = await prisma.timeRodada.findUniqueOrThrow({
      where: { timeId_temporada_rodada: { timeId, temporada, rodada } },
    });

    expect(primeira.pontuacaoParcial).toBe(4.4);
    expect(segunda.pontuacaoParcial).toBe(4.4);
    expect(await prisma.pontuacaoTimeRodada.count({ where: { timeRodadaId: timeRodada.id } })).toBe(1);
    expect(scoredCache.getScoredAthletes).toHaveBeenCalledTimes(2);
  });

  it('confirma fisicamente UNIQUE e FK de PONTUACAO_TIME_RODADA', async () => {
    await service.calcular({ timeId, temporada, rodada });
    const timeRodada = await prisma.timeRodada.findUniqueOrThrow({
      where: { timeId_temporada_rodada: { timeId, temporada, rodada } },
    });

    await expect(prisma.pontuacaoTimeRodada.create({
      data: { timeRodadaId: timeRodada.id, pontuacao: new Prisma.Decimal(0) },
    })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.pontuacaoTimeRodada.create({
      data: { timeRodadaId: 4_294_967_295, pontuacao: new Prisma.Decimal(0) },
    })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('confirma fisicamente Decimal(12,2) e enum PARCIAL/FINAL', async () => {
    const columns = await prisma.$queryRaw<Array<{ COLUMN_NAME: string; COLUMN_TYPE: string; NUMERIC_SCALE: bigint | null }>>`
      SELECT COLUMN_NAME, COLUMN_TYPE, NUMERIC_SCALE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND UPPER(TABLE_NAME) = 'PONTUACAO_TIME_RODADA'
        AND COLUMN_NAME IN ('PONTUACAO', 'STATUS')
    `;
    const pontuacao = columns.find((column) => column.COLUMN_NAME === 'PONTUACAO');
    const status = columns.find((column) => column.COLUMN_NAME === 'STATUS');

    expect(pontuacao?.COLUMN_TYPE.toLowerCase()).toBe('decimal(12,2)');
    expect(Number(pontuacao?.NUMERIC_SCALE)).toBe(2);
    expect(status?.COLUMN_TYPE).toBe("enum('PARCIAL','FINAL')");
  });
});
