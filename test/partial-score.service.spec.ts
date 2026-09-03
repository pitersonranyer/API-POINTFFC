import { BadGatewayException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PartialScoreService } from '../src/partial-score/partial-score.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';

describe('PartialScoreService', () => {
  const input = { timeId: 123, temporada: 2026, rodada: 25 };
  const titulares = [
    { atletaId: 10, posicaoId: 5, clubeId: 1, titular: true, reserva: false, capitao: false },
    { atletaId: 11, posicaoId: 4, clubeId: 2, titular: true, reserva: false, capitao: true },
    { atletaId: 12, posicaoId: 6, clubeId: 3, titular: true, reserva: false, capitao: false },
    { atletaId: 20, posicaoId: 5, clubeId: 4, titular: false, reserva: true, capitao: false },
  ];
  const prisma = {
    timeRodada: { findUnique: jest.fn() },
    pontuacaoTimeRodada: { upsert: jest.fn(), update: jest.fn() },
  };
  const scoredCache = { getScoredAthletes: jest.fn() };
  const service = new PartialScoreService(
    prisma as unknown as PrismaService,
    scoredCache as unknown as ScoredAthletesCacheService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.timeRodada.findUnique.mockResolvedValue({ id: 1, capitaoId: 11, escalacao: titulares });
    prisma.pontuacaoTimeRodada.upsert.mockResolvedValue({});
    prisma.pontuacaoTimeRodada.update.mockResolvedValue({});
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: {
        rodada: 25,
        atletas: {
          '10': { pontuacao: 10, posicao_id: 5, clube_id: 1, entrou_em_campo: true, scout: { G: 1, FS: 2 } },
          '11': { pontuacao: 4, posicao_id: 4, clube_id: 2, entrou_em_campo: true, scout: { A: 1 } },
          '12': { pontuacao: 2.5, posicao_id: 6, clube_id: 3, entrou_em_campo: true, scout: null },
          '20': { pontuacao: 100, posicao_id: 5, clube_id: 4, entrou_em_campo: true, scout: { G: 10 } },
        },
      },
      cache: 'miss',
      stale: false,
    });
  });

  it('calcula titulares, aplica capitão positivo 1,5x, contabiliza técnico e ignora reserva', async () => {
    const result = await service.calcular(input);

    expect(result.pontuacaoParcial).toBe(18.5);
    expect(result.atletas).toHaveLength(3);
    expect(result.atletas.find((atleta) => atleta.atletaId === 11)).toMatchObject({
      pontuacaoOriginal: 4,
      multiplicador: 1.5,
      pontuacaoContabilizada: 6,
      capitao: true,
    });
    expect(result.atletas.find((atleta) => atleta.posicaoId === 6)).toMatchObject({
      atletaId: 12,
      pontuacaoContabilizada: 2.5,
    });
    expect(result.atletas.some((atleta) => atleta.atletaId === 20)).toBe(false);
    expect(scoredCache.getScoredAthletes).toHaveBeenCalledTimes(1);
    expect(scoredCache.getScoredAthletes).toHaveBeenCalledWith(2026, 25);
  });

  it('aplica 1,5x também para capitão com pontuação negativa', async () => {
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada: 25, atletas: { '10': { pontuacao: 0 }, '11': { pontuacao: -4 }, '12': { pontuacao: 0 } } },
      cache: 'miss', stale: false,
    });

    const result = await service.calcular(input);

    expect(result.pontuacaoParcial).toBe(-6);
    expect(result.atletas.find((atleta) => atleta.atletaId === 11)).toMatchObject({
      pontuacaoOriginal: -4,
      pontuacaoContabilizada: -6,
    });
  });

  it('contabiliza zero e mantém status próprio quando atleta ainda não aparece em pontuados', async () => {
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada: 25, atletas: { '10': { pontuacao: 1, entrou_em_campo: true } } },
      cache: 'miss', stale: false,
    });

    const result = await service.calcular(input);
    expect(result.atletas.find((atleta) => atleta.atletaId === 11)).toMatchObject({
      pontuacaoOriginal: 0,
      pontuacaoContabilizada: 0,
      possuiPontuacao: false,
      entrouEmCampo: null,
      status: 'SEM_PONTUACAO',
    });
  });

  it('preserva scouts e entrou_em_campo no detalhamento sem persistir scouts', async () => {
    const result = await service.calcular(input);

    expect(result.atletas[0]).toMatchObject({ scouts: { G: 1, FS: 2 }, entrouEmCampo: true, possuiPontuacao: true });
    expect(prisma.pontuacaoTimeRodada.upsert.mock.calls[0][0].create).not.toHaveProperty('scouts');
  });

  it('ignora entrada global inválida, registra warning e calcula os demais atletas', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada: 25, atletas: {
        '10': { pontuacao: 10 },
        '999': { pontuacao: 'inválida', payload: { nao: 'deve ser logado' } },
        '11': { pontuacao: 4 },
        '12': { pontuacao: 2.5 },
      } },
      cache: 'miss', stale: false,
    });

    await expect(service.calcular(input)).resolves.toMatchObject({ pontuacaoParcial: 18.5 });
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: 'cartola_scored_athlete_ignored',
      atletaId: '999',
      reason: 'pontuação inválida',
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('nao');
    warning.mockRestore();
  });

  it('transforma atleta inválido do time em SEM_PONTUACAO sem interromper os demais', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada: 25, atletas: {
        '10': { pontuacao: 10 },
        '11': { pontuacao: 'inválida' },
        '12': { pontuacao: 2.5 },
      } },
      cache: 'miss', stale: false,
    });

    const result = await service.calcular(input);
    expect(result.pontuacaoParcial).toBe(12.5);
    expect(result.atletas.find((atleta) => atleta.atletaId === 11)).toMatchObject({
      pontuacaoOriginal: 0,
      pontuacaoContabilizada: 0,
      possuiPontuacao: false,
      entrouEmCampo: null,
      status: 'SEM_PONTUACAO',
    });
    expect(result.atletas.find((atleta) => atleta.atletaId === 12)?.pontuacaoContabilizada).toBe(2.5);
    warning.mockRestore();
  });

  it('usa Decimal e arredonda somente o resultado para duas casas com HALF_UP', async () => {
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada: 25, atletas: { '10': { pontuacao: 0.1 }, '11': { pontuacao: 0.2 }, '12': { pontuacao: 0.005 } } },
      cache: 'miss', stale: false,
    });

    const result = await service.calcular(input);
    expect(result.pontuacaoParcial).toBe(0.41);
    expect(result.atletas.find((atleta) => atleta.atletaId === 12)?.pontuacaoContabilizada).toBe(0.01);
  });

  it('faz upsert e atualiza a mesma pontuação em execuções repetidas', async () => {
    await service.calcular(input);
    scoredCache.getScoredAthletes.mockResolvedValue({
      value: { rodada: 25, atletas: { '10': { pontuacao: 20 }, '11': { pontuacao: 4 }, '12': { pontuacao: 2.5 } } },
      cache: 'miss', stale: false,
    });
    await service.calcular(input);

    expect(prisma.pontuacaoTimeRodada.upsert).toHaveBeenCalledTimes(2);
    for (const [call] of prisma.pontuacaoTimeRodada.upsert.mock.calls) {
      expect(call.where).toEqual({ timeRodadaId: 1 });
      expect(call.create.timeRodadaId).toBe(1);
      expect(call.update.status).toBe('PARCIAL');
    }
    expect(prisma.pontuacaoTimeRodada.upsert.mock.calls[1][0].update.pontuacao.toNumber()).toBe(28.5);
  });

  it('conclui duas execuções concorrentes recuperando somente o conflito esperado da pontuação', async () => {
    const conflito = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: 'PONTUACAO_TIME_RODADA_TIME_RODADA_ID_key' },
    });
    prisma.pontuacaoTimeRodada.upsert.mockResolvedValueOnce({}).mockRejectedValueOnce(conflito);

    const [primeira, segunda] = await Promise.all([service.calcular(input), service.calcular(input)]);

    expect(primeira.pontuacaoParcial).toBe(18.5);
    expect(segunda.pontuacaoParcial).toBe(18.5);
    expect(prisma.pontuacaoTimeRodada.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.pontuacaoTimeRodada.update).toHaveBeenCalledTimes(1);
    expect(prisma.pontuacaoTimeRodada.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { timeRodadaId: 1 },
    }));
    expect(scoredCache.getScoredAthletes).toHaveBeenCalledTimes(2);
  });

  it('não mascara P2002 de outra constraint', async () => {
    prisma.pontuacaoTimeRodada.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: 'OUTRA_CONSTRAINT_key' },
    }));

    await expect(service.calcular(input)).rejects.toMatchObject({ code: 'P2002' });
    expect(prisma.pontuacaoTimeRodada.update).not.toHaveBeenCalled();
  });

  it('faz exatamente uma chamada global por execução e nenhuma chamada por atleta', async () => {
    await service.calcular(input);
    expect(scoredCache.getScoredAthletes).toHaveBeenCalledTimes(1);
  });

  it('rejeita TIME_RODADA inexistente sem consultar pontuados', async () => {
    prisma.timeRodada.findUnique.mockResolvedValue(null);

    await expect(service.calcular(input)).rejects.toBeInstanceOf(NotFoundException);
    expect(scoredCache.getScoredAthletes).not.toHaveBeenCalled();
  });

  it.each([
    { description: 'sem escalação', escalacao: [] },
    { description: 'sem titulares', escalacao: [{ ...titulares[3] }] },
    { description: 'titular duplicado', escalacao: [titulares[0], titulares[0]] },
    { description: 'mais de um capitão', escalacao: [{ ...titulares[0], capitao: true }, titulares[1]] },
  ])('rejeita snapshot inconsistente: $description', async ({ escalacao }) => {
    prisma.timeRodada.findUnique.mockResolvedValue({ id: 1, capitaoId: 11, escalacao });

    await expect(service.calcular(input)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(scoredCache.getScoredAthletes).not.toHaveBeenCalled();
  });

  it.each([
    { description: 'atletas como array', value: { rodada: 25, atletas: [] } },
    { description: 'atletas ausente', value: { rodada: 25 } },
    { description: 'rodada ausente', value: { atletas: {} } },
    { description: 'rodada divergente', value: { rodada: 24, atletas: {} } },
  ])('rejeita envelope de pontuados inválido: $description', async ({ value }) => {
    scoredCache.getScoredAthletes.mockResolvedValue({ value, cache: 'miss', stale: false });

    await expect(service.calcular(input)).rejects.toBeInstanceOf(BadGatewayException);
    expect(prisma.pontuacaoTimeRodada.upsert).not.toHaveBeenCalled();
  });
});
