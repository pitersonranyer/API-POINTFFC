import { BadGatewayException, UnprocessableEntityException } from '@nestjs/common';
import { CartolaService } from '../src/cartola/cartola.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';
import { SubstitutionService } from '../src/substitutions/substitution.service';

describe('SubstitutionService', () => {
  const input = { timeId: 30157355, temporada: 2026, rodada: 25 };
  const snapshot = {
    id: 25,
    reservaLuxoId: 90031,
    escalacao: [
      { atletaId: 94583, posicaoId: 5, titular: true, reserva: false, capitao: false },
      { atletaId: 100, posicaoId: 4, titular: true, reserva: false, capitao: true },
      { atletaId: 101, posicaoId: 6, titular: true, reserva: false, capitao: false },
      { atletaId: 90031, posicaoId: 5, titular: false, reserva: true, capitao: false },
      { atletaId: 201, posicaoId: 4, titular: false, reserva: true, capitao: false },
    ],
  };
  const officialLuxury = [{
    saiu: { atleta_id: 94583, apelido: 'Pedro', posicao_id: 5, pontos_num: 99 },
    entrou: { atleta_id: 90031, apelido: 'Mendoza', posicao_id: 5, pontos_num: -99 },
    posicao_id: 5,
  }];
  const points = {
    rodada: 25,
    atletas: {
      '94583': { pontuacao: 1.7 },
      '90031': { pontuacao: 8 },
      '100': { pontuacao: 10 },
      '101': { pontuacao: 58.5 },
      '200': { pontuacao: 4 },
      '201': { pontuacao: 6 },
    },
  };
  const tx = {
    substituicaoTimeRodada: { deleteMany: jest.fn(), createMany: jest.fn() },
    pontuacaoTimeRodada: { upsert: jest.fn() },
  };
  const prisma = {
    timeRodada: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const cartola = { getTeamSubstitutions: jest.fn() };
  const scoredCache = { getScoredAthletes: jest.fn() };
  const service = new SubstitutionService(
    prisma as unknown as PrismaService,
    cartola as unknown as CartolaService,
    scoredCache as unknown as ScoredAthletesCacheService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.timeRodada.findUnique.mockResolvedValue(structuredClone(snapshot));
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    tx.substituicaoTimeRodada.deleteMany.mockResolvedValue({ count: 0 });
    tx.substituicaoTimeRodada.createMany.mockResolvedValue({ count: 1 });
    tx.pontuacaoTimeRodada.upsert.mockResolvedValue({});
    cartola.getTeamSubstitutions.mockResolvedValue(structuredClone(officialLuxury));
    scoredCache.getScoredAthletes.mockResolvedValue({ value: points, cache: 'hit', stale: false });
  });

  it('reproduz o caso real Pedro → Mendoza e identifica Reserva de Luxo pelo ID', async () => {
    const result = await service.processar(input);

    expect(result).toEqual({
      ...input,
      pontuacaoBase: 75.2,
      pontuacaoEfetiva: 81.5,
      reservaLuxoId: 90031,
      substituicoes: [{
        saiu: { atletaId: 94583, pontuacao: 1.7 },
        entrou: { atletaId: 90031, pontuacao: 8 },
        posicaoId: 5,
        delta: 6.3,
        reservaLuxo: true,
      }],
    });
    expect(scoredCache.getScoredAthletes).toHaveBeenCalledTimes(1);
    expect(scoredCache.getScoredAthletes).toHaveBeenCalledWith(2026, 25);
    expect(cartola.getTeamSubstitutions).toHaveBeenCalledWith(30157355);
  });

  it('mantém base e efetiva iguais quando não há substituições', async () => {
    cartola.getTeamSubstitutions.mockResolvedValue([]);

    const result = await service.processar(input);

    expect(result).toMatchObject({ pontuacaoBase: 75.2, pontuacaoEfetiva: 75.2, substituicoes: [] });
    expect(tx.substituicaoTimeRodada.createMany).not.toHaveBeenCalled();
    expect(tx.substituicaoTimeRodada.deleteMany).toHaveBeenCalledWith({ where: { timeRodadaId: 25 } });
  });

  it('processa uma reserva normal com reservaLuxo false', async () => {
    prisma.timeRodada.findUnique.mockResolvedValue({
      ...structuredClone(snapshot),
      escalacao: [
        ...structuredClone(snapshot.escalacao),
        { atletaId: 200, posicaoId: 4, titular: true, reserva: false, capitao: false },
      ],
    });
    cartola.getTeamSubstitutions.mockResolvedValue([{ saiu: { atleta_id: 200, posicao_id: 4 }, entrou: { atleta_id: 201, posicao_id: 4 }, posicao_id: 4 }]);

    const result = await service.processar(input);

    expect(result.substituicoes[0]).toMatchObject({ delta: 2, reservaLuxo: false });
  });

  it('processa múltiplas substituições oficiais', async () => {
    prisma.timeRodada.findUnique.mockResolvedValue({
      ...structuredClone(snapshot),
      escalacao: [
        ...structuredClone(snapshot.escalacao),
        { atletaId: 200, posicaoId: 4, titular: true, reserva: false, capitao: false },
      ],
    });
    cartola.getTeamSubstitutions.mockResolvedValue([
      ...structuredClone(officialLuxury),
      { saiu: { atleta_id: 200, posicao_id: 4 }, entrou: { atleta_id: 201, posicao_id: 4 }, posicao_id: 4 },
    ]);

    const result = await service.processar(input);

    expect(result.substituicoes).toHaveLength(2);
    expect(result).toMatchObject({ pontuacaoBase: 79.2, pontuacaoEfetiva: 87.5 });
  });

  it('é idempotente e usa createMany skipDuplicates sem acumular delta', async () => {
    const first = await service.processar(input);
    const second = await service.processar(input);

    expect(first.pontuacaoEfetiva).toBe(81.5);
    expect(second.pontuacaoEfetiva).toBe(81.5);
    expect(tx.substituicaoTimeRodada.createMany).toHaveBeenCalledTimes(2);
    expect(tx.substituicaoTimeRodada.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(tx.pontuacaoTimeRodada.upsert).toHaveBeenCalledTimes(2);
  });

  it('termina duas execuções concorrentes com o mesmo total', async () => {
    const [first, second] = await Promise.all([service.processar(input), service.processar(input)]);

    expect(first.pontuacaoEfetiva).toBe(81.5);
    expect(second.pontuacaoEfetiva).toBe(81.5);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.substituicaoTimeRodada.createMany.mock.calls.every(([arg]) => arg.skipDuplicates === true)).toBe(true);
  });

  it('recalcula o total completo com pontuações globais atualizadas', async () => {
    await service.processar(input);
    scoredCache.getScoredAthletes.mockResolvedValueOnce({
      value: { ...points, atletas: { ...points.atletas, '94583': { pontuacao: 2 }, '90031': { pontuacao: 10 }, '101': { pontuacao: 50 } } },
      cache: 'miss',
      stale: false,
    });

    const result = await service.processar(input);

    expect(result).toMatchObject({ pontuacaoBase: 67, pontuacaoEfetiva: 75 });
    const persisted = tx.pontuacaoTimeRodada.upsert.mock.calls[1][0].update.pontuacao;
    expect(persisted.toNumber()).toBe(75);
  });

  it('usa zero quando o atleta que entra ainda não possui pontuação', async () => {
    const { '90031': _missing, ...withoutMendoza } = points.atletas;
    void _missing;
    scoredCache.getScoredAthletes.mockResolvedValue({ value: { ...points, atletas: withoutMendoza }, cache: 'hit', stale: false });

    const result = await service.processar(input);

    expect(result.substituicoes[0]).toMatchObject({ entrou: { atletaId: 90031, pontuacao: 0 }, delta: -1.7 });
    expect(result.pontuacaoEfetiva).toBe(73.5);
  });

  it('mantém capitão 1,5 e técnico exatamente com a pontuação da API', async () => {
    const result = await service.processar(input);

    expect(result.pontuacaoBase).toBe(1.7 + 10 * 1.5 + 58.5);
    expect(result.pontuacaoEfetiva).toBe(8 + 10 * 1.5 + 58.5);
  });

  it('funciona com snapshot antigo sem reservaLuxoId', async () => {
    prisma.timeRodada.findUnique.mockResolvedValue({ ...structuredClone(snapshot), reservaLuxoId: null });

    const result = await service.processar(input);

    expect(result.reservaLuxoId).toBeNull();
    expect(result.substituicoes[0].reservaLuxo).toBe(false);
  });

  it('rejeita atleta que saiu fora dos titulares originais', async () => {
    cartola.getTeamSubstitutions.mockResolvedValue([{ saiu: { atleta_id: 999, posicao_id: 5 }, entrou: { atleta_id: 90031, posicao_id: 5 }, posicao_id: 5 }]);
    await expect(service.processar(input)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejeita atleta que entrou fora das reservas originais', async () => {
    cartola.getTeamSubstitutions.mockResolvedValue([{ saiu: { atleta_id: 94583, posicao_id: 5 }, entrou: { atleta_id: 999, posicao_id: 5 }, posicao_id: 5 }]);
    await expect(service.processar(input)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    [{ entrou: {}, saiu: {}, posicao_id: 5 }],
    [{ entrou: { atleta_id: 90031, posicao_id: 5 }, saiu: { atleta_id: 94583, posicao_id: 4 }, posicao_id: 5 }],
    [...officialLuxury, ...officialLuxury],
  ])('rejeita payload externo inválido: %p', async (payload) => {
    cartola.getTeamSubstitutions.mockResolvedValue(payload);
    await expect(service.processar(input)).rejects.toBeInstanceOf(BadGatewayException);
    expect(scoredCache.getScoredAthletes).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('não modifica os registros da escalação original', async () => {
    const original = structuredClone(snapshot.escalacao);
    await service.processar(input);
    expect(snapshot.escalacao).toEqual(original);
    expect(tx.substituicaoTimeRodada.createMany.mock.calls[0][0].data[0]).not.toHaveProperty('titular');
  });
});
