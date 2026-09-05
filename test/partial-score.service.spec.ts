import { Prisma } from '@prisma/client';
import { PartialScoreService } from '../src/partial-score/partial-score.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('PartialScoreService - leitura da rodada processada', () => {
  const input = { timeId: 1, temporada: 2026, rodada: 25 };
  const prisma = { timeRodada: { findUnique: jest.fn() }, rodadaProcessamento: { findUnique: jest.fn() }, $transaction: (operations: Promise<unknown>[]) => Promise.all(operations) };
  const service = new PartialScoreService(prisma as unknown as PrismaService);
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.timeRodada.findUnique.mockResolvedValue({
      id: 1, capitaoId: 10, reservaLuxoId: 20,
      pontuacao: { status: 'FINAL', pontuacao: new Prisma.Decimal(19) }, substituicoes: [],
      escalacao: [
        { atletaId: 10, posicaoId: 5, clubeId: 1, titular: true, reserva: false, capitao: true },
        { atletaId: 11, posicaoId: 6, clubeId: 2, titular: true, reserva: false, capitao: false },
        { atletaId: 20, posicaoId: 5, clubeId: 3, titular: false, reserva: true, capitao: false },
      ],
    });
    prisma.rodadaProcessamento.findUnique.mockResolvedValue({ status: 'CONSOLIDADA',
      pontuados: { rodada: 25, atletas: { '10': { pontuacao: 10, entrou_em_campo: true, scout: { G: 1 } },
        '11': { pontuacao: 4 }, '20': { pontuacao: 20 } } },
    });
  });
  it('le pontuacao final, tecnico e capitao sem dependencias externas ou escrita', async () => {
    const result = await service.calcular(input);
    expect(result).toMatchObject({ status: 'FINAL', pontuacaoParcial: 19 });
    expect(result.atletas).toHaveLength(2);
    expect(result.atletas[0]).toMatchObject({ multiplicador: 1.5, scouts: { G: 1 } });
  });
  it('preserva capitao negativo', async () => {
    prisma.rodadaProcessamento.findUnique.mockResolvedValue({ pontuados: { rodada: 25, atletas: { '10': { pontuacao: -2 }, '11': { pontuacao: 4 } } } });
    expect((await service.calcular(input)).pontuacaoParcial).toBe(1);
  });
  it('ausente tem zero e participacao desconhecida, sem substituir', async () => {
    prisma.rodadaProcessamento.findUnique.mockResolvedValue({ pontuados: { rodada: 25, atletas: {} } });
    const result = await service.calcular(input);
    expect(result.atletas[0]).toMatchObject({ pontuacaoOriginal: 0, entrouEmCampo: null, status: 'SEM_PONTUACAO' });
  });
  it('usa substituicao persistida e transfere capitao', async () => {
    const snapshot = await prisma.timeRodada.findUnique();
    snapshot.substituicoes = [{ atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 5 }];
    const result = await service.calcular(input);
    expect(result.pontuacaoParcial).toBe(34);
    expect(result.atletas.map((a) => a.atletaId)).toEqual([11, 20]);
  });
  it('nao fabrica dados sem snapshot nem sem rodada processada', async () => {
    prisma.timeRodada.findUnique.mockResolvedValueOnce(null);
    await expect(service.calcular(input)).rejects.toThrow('Snapshot');
    prisma.rodadaProcessamento.findUnique.mockResolvedValueOnce(null);
    await expect(service.calcular(input)).rejects.toThrow('scheduler');
  });
  it('rejeita capitães inconsistentes', async () => {
    const snapshot = await prisma.timeRodada.findUnique();
    snapshot.escalacao[1].capitao = true;
    await expect(service.calcular(input)).rejects.toThrow('capitão');
  });
  it('reexecucao da leitura mantem resultado identico', async () => {
    expect(await service.calcular(input)).toEqual(await service.calcular(input));
  });
});
