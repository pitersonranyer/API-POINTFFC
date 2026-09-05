import { CartolaService } from '../src/cartola/cartola.service';
import { CartolaCacheService } from '../src/cartola/cartola-cache.service';
import { CartolaHttpClient } from '../src/cartola/cartola-http.client';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Banco como fonte oficial de atletas e partidas', () => {
  const http = { get: jest.fn() };
  const prisma = { rodadaProcessamento: { findFirst: jest.fn(), findUnique: jest.fn() } };
  const service = new CartolaService(http as unknown as CartolaHttpClient, new CartolaCacheService(), prisma as unknown as PrismaService);
  const pontuados = { rodada: 25, atletas: { '10': { pontuacao: 10, apelido: 'Atleta', scout: { G: 1 }, entrou_em_campo: true } } };
  const partidas = { rodada: 25, partidas: [], clubes: {} };
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.rodadaProcessamento.findFirst.mockResolvedValue({ temporada: 2026 });
    prisma.rodadaProcessamento.findUnique.mockResolvedValue({ status: 'CONSOLIDADA', pontuados, partidas });
  });
  it('consulta consolidada nao chama nem status do mercado', async () => {
    expect((await service.getScoredAthletes(25)).value).toEqual(pontuados);
    expect((await service.getMatchesByRound(25)).value).toEqual(partidas);
    expect(http.get).not.toHaveBeenCalled();
  });
  it('refresh usado pelo cache tambem respeita consolidacao', async () => {
    expect((await service.loadScoredAthletesFresh(25)).value).toEqual(pontuados);
    expect(http.get).not.toHaveBeenCalled();
  });
  it('seleciona temporada explicita sem consultar Cartola', async () => {
    await service.getScoredAthletes(25, 2025);
    expect(prisma.rodadaProcessamento.findUnique).toHaveBeenCalledWith({ where: { temporada_rodada: { temporada: 2025, rodada: 25 } } });
    expect(http.get).not.toHaveBeenCalled();
  });
  it('nao usa rede para reparar historico consolidado incompleto', async () => {
    prisma.rodadaProcessamento.findUnique.mockResolvedValue({ status: 'CONSOLIDADA', pontuados: null });
    await expect(service.getScoredAthletes(25)).rejects.toThrow('sem atletas');
    await expect(service.loadScoredAthletesFresh(25)).rejects.toThrow('sem atletas');
    expect(http.get).not.toHaveBeenCalled();
  });
});
