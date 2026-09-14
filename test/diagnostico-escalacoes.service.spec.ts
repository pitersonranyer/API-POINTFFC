import { DiagnosticoEscalacoesService } from '../src/ligas-competicoes/diagnostico-escalacoes.service';
import { PrismaService } from '../src/prisma/prisma.service';

const competicao = { id: 7, rodadaInicio: 27, rodadaFim: 27, dataInicio: new Date('2026-09-01T00:00:00.000Z') };

function setup() {
  const prisma = {
    competicaoLiga: { findUnique: jest.fn(async () => competicao) },
    inscricaoTimeCompeticao: { findMany: jest.fn(async () => [
      { id: 10, timeIdCartola: 101, nomeTime: 'Azul' },
      { id: 11, timeIdCartola: 202, nomeTime: 'Verde' },
    ]) },
    timeRodada: { findMany: jest.fn(async () => [{ id: 55, timeId: 101 }]) },
  };
  return { prisma, service: new DiagnosticoEscalacoesService(prisma as unknown as PrismaService) };
}

describe('DiagnosticoEscalacoesService', () => {
  it('retorna zero sem inscricoes e dispensa consulta de escalacoes', async () => {
    const { prisma, service } = setup();
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([]);
    expect(await service.diagnosticar(7)).toEqual({ competicaoId: 7, rodada: 27,
      quantidadeInscricoesAtivas: 0, quantidadeEscalacoesEncontradas: 0,
      quantidadeEscalacoesPendentes: 0, pendencias: [] });
    expect(prisma.timeRodada.findMany).not.toHaveBeenCalled();
  });

  it('associa pelo snapshot da inscricao e informa encontrada e pendente', async () => {
    const { prisma, service } = setup();
    expect(await service.associar(7)).toMatchObject({ temporada: 2026, rodada: 27, inscricoes: [
      { inscricaoId: 10, timeIdCartola: 101, rodada: 27, escalacaoEncontrada: true, timeRodadaId: 55 },
      { inscricaoId: 11, timeIdCartola: 202, rodada: 27, escalacaoEncontrada: false, timeRodadaId: null },
    ] });
    expect(await service.diagnosticar(7)).toEqual({ competicaoId: 7, rodada: 27,
      quantidadeInscricoesAtivas: 2, quantidadeEscalacoesEncontradas: 1,
      quantidadeEscalacoesPendentes: 1,
      pendencias: [{ inscricaoId: 11, timeIdCartola: 202, nomeTime: 'Verde' }] });
    expect(prisma.inscricaoTimeCompeticao.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { competicaoLigaId: 7, statusInscricao: 'ATIVA' },
    }));
    expect(prisma.timeRodada.findMany).toHaveBeenCalledWith({
      where: { temporada: 2026, rodada: 27, timeId: { in: [101, 202] }, escalacao: { some: { titular: true } } },
      select: { id: true, timeId: true },
    });
    expect(Object.keys(prisma)).not.toContain('timeUsuario');
  });

  it('rejeita competicao inexistente ou sem rodada unica e temporada', async () => {
    const { prisma, service } = setup();
    prisma.competicaoLiga.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.associar(7)).rejects.toMatchObject({ status: 404 });
    prisma.competicaoLiga.findUnique.mockResolvedValueOnce({ ...competicao, rodadaFim: 28 });
    await expect(service.associar(7)).rejects.toMatchObject({ status: 400 });
    prisma.competicaoLiga.findUnique.mockResolvedValueOnce({ ...competicao, dataInicio: null } as never);
    await expect(service.associar(7)).rejects.toMatchObject({ status: 400 });
  });
});
