import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SubstitutionService } from '../src/substitutions/substitution.service';

const integration = process.env.RUN_MYSQL_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
integration('Substituicoes persistidas - MySQL com rollback', () => {
  const prisma = new PrismaClient();
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  it('le somente substituicoes ativas e preserva escalação congelada', async () => {
    const rollback = new Error('ROLLBACK_TEST');
    await expect(prisma.$transaction(async (tx) => {
      const input = { timeId: 2147483020, temporada: 65000, rodada: 36 };
      await tx.timeCartola.create({ data: { timeId: input.timeId, nomeTime: 'Teste transacional' } });
      const team = await tx.timeRodada.create({ data: { ...input, capitaoId: 10, reservaLuxoId: 20,
        escalacao: { create: [
          { atletaId: 10, posicaoId: 5, titular: true, reserva: false, capitao: true },
          { atletaId: 20, posicaoId: 5, titular: false, reserva: true, capitao: false },
        ] }, substituicoes: { create: { atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 5, ativa: true } },
      } });
      await tx.rodadaProcessamento.create({ data: { temporada: input.temporada, rodada: input.rodada,
        status: 'CONSOLIDADA', timesPrevistos: [input.timeId], falhasSnapshot: [],
        pontuados: { rodada: input.rodada, atletas: { '10': { pontuacao: 2 }, '20': { pontuacao: 8 } } },
      } });
      const service = new SubstitutionService({ ...tx, $transaction: (operations: Promise<unknown>[]) => Promise.all(operations) } as unknown as PrismaService);
      expect(await service.processar(input)).toMatchObject({ pontuacaoEfetiva: 12 });
      await tx.substituicaoTimeRodada.updateMany({ where: { timeRodadaId: team.id }, data: { ativa: false } });
      expect(await service.processar(input)).toMatchObject({ pontuacaoEfetiva: 3 });
      expect(await tx.escalacaoTimeRodada.count({ where: { timeRodadaId: team.id, titular: true } })).toBe(1);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
