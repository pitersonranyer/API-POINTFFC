import { PrismaClient } from '@prisma/client';
import { CartolaService } from '../src/cartola/cartola.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';
import { SubstitutionService } from '../src/substitutions/substitution.service';

const describeIntegration = process.env.RUN_MYSQL_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeIntegration('SubstitutionService - integração MySQL', () => {
  const prisma = new PrismaClient();
  const timeId = 2_147_483_020;
  const temporada = 65_000;
  const rodada = 36;
  const saiuId = 2_147_483_021;
  const entrouId = 2_147_483_022;
  const capitaoId = 2_147_483_023;
  const cartola = {
    getTeamSubstitutions: jest.fn().mockResolvedValue([
      { saiu: { atleta_id: saiuId, posicao_id: 5 }, entrou: { atleta_id: entrouId, posicao_id: 5 }, posicao_id: 5 },
    ]),
  };
  const scored = {
    getScoredAthletes: jest.fn().mockResolvedValue({
      value: { rodada, atletas: {
        [saiuId]: { pontuacao: 1.7 },
        [entrouId]: { pontuacao: 8 },
        [capitaoId]: { pontuacao: 10 },
      } },
      cache: 'hit', stale: false,
    }),
  };
  const service = new SubstitutionService(
    prisma as unknown as PrismaService,
    cartola as unknown as CartolaService,
    scored as unknown as ScoredAthletesCacheService,
  );

  beforeAll(() => prisma.$connect());

  beforeEach(async () => {
    await prisma.timeRodada.deleteMany({ where: { timeId, temporada } });
    await prisma.timeCartola.deleteMany({ where: { timeId } });
    await prisma.timeCartola.create({ data: { timeId, nomeTime: 'Time integração substituições' } });
    const rodadaLocal = await prisma.timeRodada.create({
      data: { timeId, temporada, rodada, capitaoId, reservaLuxoId: entrouId },
    });
    await prisma.escalacaoTimeRodada.createMany({ data: [
      { timeRodadaId: rodadaLocal.id, atletaId: saiuId, posicaoId: 5, titular: true, reserva: false, capitao: false },
      { timeRodadaId: rodadaLocal.id, atletaId: capitaoId, posicaoId: 4, titular: true, reserva: false, capitao: true },
      { timeRodadaId: rodadaLocal.id, atletaId: entrouId, posicaoId: 5, titular: false, reserva: true, capitao: false },
    ] });
  });

  afterEach(async () => {
    await prisma.timeRodada.deleteMany({ where: { timeId, temporada } });
    await prisma.timeCartola.deleteMany({ where: { timeId } });
  });

  afterAll(() => prisma.$disconnect());

  it('persiste uma substituição e uma pontuação sob reexecução e concorrência', async () => {
    const first = await service.processar({ timeId, temporada, rodada });
    const concurrent = await Promise.all([
      service.processar({ timeId, temporada, rodada }),
      service.processar({ timeId, temporada, rodada }),
    ]);
    const timeRodada = await prisma.timeRodada.findUniqueOrThrow({
      where: { timeId_temporada_rodada: { timeId, temporada, rodada } },
      include: { pontuacao: true, substituicoes: true, escalacao: true },
    });

    expect(first).toMatchObject({ pontuacaoBase: 16.7, pontuacaoEfetiva: 23, reservaLuxoId: entrouId });
    expect(concurrent.every((result) => result.pontuacaoEfetiva === 23)).toBe(true);
    expect(timeRodada.substituicoes).toHaveLength(1);
    expect(timeRodada.pontuacao?.pontuacao.toNumber()).toBe(23);
    expect(timeRodada.escalacao).toHaveLength(3);
  });

  it('confirma fisicamente UNIQUE, FK e coluna RESERVA_LUXO_ID', async () => {
    await service.processar({ timeId, temporada, rodada });
    const timeRodada = await prisma.timeRodada.findUniqueOrThrow({
      where: { timeId_temporada_rodada: { timeId, temporada, rodada } },
      include: { substituicoes: true },
    });
    const persisted = timeRodada.substituicoes[0];

    expect(timeRodada.reservaLuxoId).toBe(entrouId);
    await expect(prisma.substituicaoTimeRodada.create({
      data: { timeRodadaId: timeRodada.id, atletaSaiuId: saiuId, atletaEntrouId: entrouId, posicaoId: 5 },
    })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.substituicaoTimeRodada.create({
      data: { timeRodadaId: 'time-rodada-inexistente', atletaSaiuId: saiuId, atletaEntrouId: entrouId + 1, posicaoId: 5 },
    })).rejects.toMatchObject({ code: 'P2003' });
    expect(persisted).toMatchObject({ atletaSaiuId: saiuId, atletaEntrouId: entrouId, posicaoId: 5 });
  });

  it('confirma tipos físicos e índices das migrations', async () => {
    const columns = await prisma.$queryRaw<Array<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string }>>`
      SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'TIME_RODADA' AND COLUMN_NAME = 'RESERVA_LUXO_ID')
          OR TABLE_NAME = 'SUBSTITUICAO_TIME_RODADA')
    `;
    const indexes = await prisma.$queryRaw<Array<{ INDEX_NAME: string; NON_UNIQUE: bigint }>>`
      SELECT DISTINCT INDEX_NAME, NON_UNIQUE
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SUBSTITUICAO_TIME_RODADA'
    `;

    expect(columns.find((column) => column.COLUMN_NAME === 'RESERVA_LUXO_ID')).toMatchObject({
      COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'YES',
    });
    expect(indexes.find((index) => index.INDEX_NAME === 'SUB_TR_PAIR_key')).toMatchObject({ NON_UNIQUE: BigInt(0) });
  });
});
