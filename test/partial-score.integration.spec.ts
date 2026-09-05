import { PrismaClient } from '@prisma/client';
import { PartialScoreService } from '../src/partial-score/partial-score.service';
import { PrismaService } from '../src/prisma/prisma.service';

const integration = process.env.RUN_MYSQL_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
integration('Leitura consolidada - MySQL com rollback', () => {
  const prisma = new PrismaClient();
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  it('le Decimal e FINAL sem modificar pontuacao; preserva UNIQUE', async () => {
    const rollback = new Error('ROLLBACK_TEST');
    await expect(prisma.$transaction(async (tx) => {
      const input = { timeId: 2147483010, temporada: 65000, rodada: 37 };
      await tx.timeCartola.create({ data: { timeId: input.timeId, nomeTime: 'Teste transacional' } });
      const team = await tx.timeRodada.create({ data: { ...input, capitaoId: 10,
        escalacao: { create: [
          { atletaId: 10, posicaoId: 5, titular: true, reserva: false, capitao: true },
          { atletaId: 11, posicaoId: 6, titular: true, reserva: false, capitao: false },
        ] }, pontuacao: { create: { pontuacao: 4.4, status: 'FINAL' } },
      } });
      await tx.rodadaProcessamento.create({ data: { temporada: input.temporada, rodada: input.rodada,
        status: 'CONSOLIDADA', timesPrevistos: [input.timeId], falhasSnapshot: [],
        pontuados: { rodada: input.rodada, atletas: { '10': { pontuacao: 2.2 }, '11': { pontuacao: 1.1 } } },
      } });
      const service = new PartialScoreService({ ...tx, $transaction: (operations: Promise<unknown>[]) => Promise.all(operations) } as unknown as PrismaService);
      expect(await service.calcular(input)).toMatchObject({ status: 'FINAL', pontuacaoParcial: 4.4 });
      expect(await tx.pontuacaoTimeRodada.count({ where: { timeRodadaId: team.id } })).toBe(1);
      await expect(tx.pontuacaoTimeRodada.create({ data: { timeRodadaId: team.id, pontuacao: 0 } })).rejects.toMatchObject({ code: 'P2002' });
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
