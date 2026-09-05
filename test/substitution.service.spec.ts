import { SubstitutionService } from '../src/substitutions/substitution.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('SubstitutionService - leitura sem alterar snapshot ou pontuacao', () => {
  const prisma = { timeRodada: { findUnique: jest.fn() }, rodadaProcessamento: { findUnique: jest.fn() }, $transaction: (operations: Promise<unknown>[]) => Promise.all(operations) };
  const service = new SubstitutionService(prisma as unknown as PrismaService);
  const input = { timeId: 1, temporada: 2026, rodada: 25 };
  beforeEach(() => {
    prisma.timeRodada.findUnique.mockResolvedValue({
      id: 1, capitaoId: 10, reservaLuxoId: 20,
      escalacao: [
        { atletaId: 10, posicaoId: 5, titular: true, reserva: false, capitao: true },
        { atletaId: 20, posicaoId: 5, titular: false, reserva: true, capitao: false },
      ],
      substituicoes: [{ atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 5 }],
    });
    prisma.rodadaProcessamento.findUnique.mockResolvedValue({
      pontuados: { rodada: 25, atletas: { '10': { pontuacao: 2 }, '20': { pontuacao: 8 } } },
    });
  });
  it('reusa trocas persistidas e mantem capitao no substituto', async () => {
    const result = await service.processar(input);
    expect(result).toMatchObject({ pontuacaoBase: 3, pontuacaoEfetiva: 12, reservaLuxoId: 20 });
    expect(result.substituicoes[0]).toMatchObject({ reservaLuxo: true, posicaoId: 5 });
    expect(await service.processar(input)).toEqual(result);
  });
  it('rejeita troca fora do snapshot', async () => {
    const snapshot = await prisma.timeRodada.findUnique();
    snapshot.substituicoes[0].atletaEntrouId = 999;
    await expect(service.processar(input)).rejects.toThrow('reservas originais');
  });
  it('nao consulta Cartola quando nao ha dados persistidos', async () => {
    prisma.rodadaProcessamento.findUnique.mockResolvedValue(null);
    await expect(service.processar(input)).rejects.toThrow('scheduler');
  });
});
