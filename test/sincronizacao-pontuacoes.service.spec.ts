import { Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { DiagnosticoEscalacoesService } from '../src/ligas-competicoes/diagnostico-escalacoes.service';
import { RankingCompeticaoService } from '../src/ligas-competicoes/ranking-competicao.service';
import { SincronizacaoPontuacoesService } from '../src/ligas-competicoes/sincronizacao-pontuacoes.service';
import { PrismaService } from '../src/prisma/prisma.service';

function setup() {
  const prisma = {
    competicaoLiga: { findMany: jest.fn(async () => [] as Array<{ id: number }>) },
    inscricaoTimeCompeticao: { findMany: jest.fn(async () => [
      { id: 1, timeIdCartola: 101, nomeTime: 'Azul' },
      { id: 2, timeIdCartola: 202, nomeTime: 'Verde' },
      { id: 3, timeIdCartola: 303, nomeTime: 'Vermelho' },
    ]) },
    timeRodada: { findMany: jest.fn(async () => [
      { timeId: 101, pontuacao: { pontuacao: new Prisma.Decimal('12.50') } },
      { timeId: 202, pontuacao: null },
    ]) },
  };
  const diagnostico = { obterContextoRodadaUnica: jest.fn(async () => ({ rodada: 27, temporada: 2026 })) };
  const ranking = { atualizarPontuacoes: jest.fn(async (_competicaoId: number,
    _atualizacoes: Array<{ inscricaoId: number; pontuacao: Prisma.Decimal | string | number }>) => undefined) };
  return { prisma, diagnostico, ranking, service: new SincronizacaoPontuacoesService(
    prisma as unknown as PrismaService, diagnostico as unknown as DiagnosticoEscalacoesService,
    ranking as unknown as RankingCompeticaoService) };
}

describe('SincronizacaoPontuacoesService', () => {
  beforeAll(() => Logger.overrideLogger([]));
  it('nao sincroniza quando nao ha competicoes elegiveis ou participantes', async () => {
    const { prisma, ranking, service } = setup();
    await service.sincronizarRodada(2026, 27);
    expect(prisma.competicaoLiga.findMany).toHaveBeenCalledWith({
      where: { rodadaInicio: 27, rodadaFim: 27,
        dataInicio: { gte: new Date('2026-01-01T00:00:00.000Z'), lt: new Date('2027-01-01T00:00:00.000Z') },
        visivelApp: true,
        status: { in: ['INSCRICOES_ABERTAS', 'INSCRICOES_ENCERRADAS', 'EM_ANDAMENTO', 'ENCERRADA'] },
        ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: true }, modalidade: { ativa: true } },
        inscricoes: { some: { statusInscricao: 'ATIVA' } },
      }, select: { id: true }, orderBy: { id: 'asc' },
    });
    expect(prisma.inscricaoTimeCompeticao.findMany).not.toHaveBeenCalled();
    expect(ranking.atualizarPontuacoes).not.toHaveBeenCalled();
  });

  it('sincroniza cada competicao impactada uma vez, isolando falha individual', async () => {
    const { prisma, service } = setup();
    prisma.competicaoLiga.findMany.mockResolvedValue([{ id: 7 }, { id: 7 }, { id: 8 }]);
    const sincronizar = jest.spyOn(service, 'sincronizarPontuacoesCompeticao');
    sincronizar.mockRejectedValueOnce(new Error('Falha isolada'));
    await expect(service.sincronizarRodada(2026, 27)).resolves.toBeUndefined();
    expect(sincronizar.mock.calls.map(([id]) => id)).toEqual([7, 8]);
  });

  it('usa pontos persistidos, ignora pendentes e sincroniza os demais', async () => {
    const { prisma, diagnostico, ranking, service } = setup();
    expect(await service.sincronizarPontuacoesCompeticao(7)).toEqual({ competicaoId: 7, rodada: 27,
      quantidadeInscricoesAtivas: 3, quantidadeAtualizadas: 1, quantidadePendentes: 2,
      pendencias: [
        { inscricaoId: 2, timeIdCartola: 202, nomeTime: 'Verde', motivo: 'PONTUACAO_INDISPONIVEL' },
        { inscricaoId: 3, timeIdCartola: 303, nomeTime: 'Vermelho', motivo: 'TIME_RODADA_NAO_ENCONTRADO' },
      ] });
    expect(diagnostico.obterContextoRodadaUnica).toHaveBeenCalledWith(7);
    expect(prisma.inscricaoTimeCompeticao.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { competicaoLigaId: 7, statusInscricao: 'ATIVA' },
    }));
    expect(prisma.timeRodada.findMany).toHaveBeenCalledWith({
      where: { temporada: 2026, rodada: 27, timeId: { in: [101, 202, 303] } },
      select: { timeId: true, pontuacao: { select: { pontuacao: true } } },
    });
    expect(ranking.atualizarPontuacoes).toHaveBeenCalledWith(7, [
      { inscricaoId: 1, pontuacao: new Prisma.Decimal('12.50') },
    ]);
    expect(Object.keys(prisma)).not.toContain('timeUsuario');
  });

  it('sincroniza varias inscricoes, inclusive pontuacao real zero', async () => {
    const { prisma, ranking, service } = setup();
    prisma.timeRodada.findMany.mockResolvedValue([
      { timeId: 101, pontuacao: { pontuacao: new Prisma.Decimal('0.00') } },
      { timeId: 202, pontuacao: { pontuacao: new Prisma.Decimal('18.25') } },
      { timeId: 303, pontuacao: { pontuacao: new Prisma.Decimal('7.00') } },
    ]);
    expect(await service.sincronizarPontuacoesCompeticao(7)).toMatchObject({ quantidadeAtualizadas: 3, quantidadePendentes: 0 });
    expect(ranking.atualizarPontuacoes.mock.calls[0][1].map(item => item.pontuacao.toString()))
      .toEqual(['0', '18.25', '7']);
  });

  it('nao atualiza ranking quando nenhuma pontuacao esta disponivel', async () => {
    const { prisma, ranking, service } = setup();
    prisma.timeRodada.findMany.mockResolvedValue([]);
    expect(await service.sincronizarPontuacoesCompeticao(7)).toMatchObject({ quantidadeAtualizadas: 0, quantidadePendentes: 3 });
    expect(ranking.atualizarPontuacoes).not.toHaveBeenCalled();
  });

  it('rejeita competicao de varias rodadas antes de consultar times', async () => {
    const { prisma, diagnostico, ranking, service } = setup();
    diagnostico.obterContextoRodadaUnica.mockRejectedValueOnce({ status: 400 });
    await expect(service.sincronizarPontuacoesCompeticao(7)).rejects.toMatchObject({ status: 400 });
    expect(prisma.inscricaoTimeCompeticao.findMany).not.toHaveBeenCalled();
    expect(ranking.atualizarPontuacoes).not.toHaveBeenCalled();
  });
});
