import { LigasCompeticoesService } from '../ligas-competicoes/ligas-competicoes.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramCompetitionsService } from './telegram-competitions.service';

describe('TelegramCompetitionsService', () => {
  const openCompetition = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    nome: `POINT FFC - Rodada ${id}`,
    slug: `rodada-${id}`,
    tipoAcesso: 'FREE',
    valorInscricao: 0,
    rodadaInicio: id,
    rodadaFim: id,
    inicioInscricao: '2026-09-10T00:00:00.000Z',
    fimInscricao: '2026-09-20T00:00:00.000Z',
    limiteTimesUsuario: 30,
    limiteParticipantes: null,
    status: 'INSCRICOES_ABERTAS',
    ...overrides,
  });

  const ligasService = { listarCompeticoes: jest.fn() };
  const prisma = { inscricaoTimeCompeticao: { groupBy: jest.fn() } };
  const service = new TelegramCompetitionsService(
    ligasService as unknown as LigasCompeticoesService,
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    ligasService.listarCompeticoes.mockResolvedValue([
      openCompetition(1, { limiteParticipantes: 2 }),
      openCompetition(2, { inicioInscricao: '2026-09-16T00:00:00.000Z' }),
      openCompetition(3),
      openCompetition(4, { status: 'EM_ANDAMENTO' }),
    ]);
    prisma.inscricaoTimeCompeticao.groupBy.mockResolvedValue([
      { competicaoLigaId: 1, _count: { _all: 2 } },
    ]);
  });

  it('reuses the public league list and filters by the shared signup eligibility rules', async () => {
    const result = await service.listarDivulgaveis(new Date('2026-09-15T12:00:00.000Z'));

    expect(ligasService.listarCompeticoes).toHaveBeenCalledWith('point-ffc', { status: 'INSCRICOES_ABERTAS' });
    expect(prisma.inscricaoTimeCompeticao.groupBy).toHaveBeenCalledWith({
      by: ['competicaoLigaId'],
      where: { competicaoLigaId: { in: [1, 2, 3, 4] }, statusInscricao: 'ATIVA' },
      _count: { _all: true },
    });
    expect(result.map(item => item.id)).toEqual([3]);
  });

  it('does not query enrollment counts when the public list is empty', async () => {
    ligasService.listarCompeticoes.mockResolvedValueOnce([]);

    expect(await service.listarDivulgaveis()).toEqual([]);
    expect(prisma.inscricaoTimeCompeticao.groupBy).not.toHaveBeenCalled();
  });
});
