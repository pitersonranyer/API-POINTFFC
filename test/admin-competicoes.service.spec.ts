import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CompeticaoLigaStatus, CompeticaoTipoAcesso, Prisma } from '@prisma/client';
import { AdminCompeticoesService } from '../src/admin/admin-competicoes.service';
import { AdminLigasService } from '../src/admin/admin-ligas.service';
import { CriarAdminCompeticaoDto } from '../src/admin/dto/admin-competicoes.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const baseDto = (change: Partial<CriarAdminCompeticaoDto> = {}): CriarAdminCompeticaoDto => ({
  ligaModalidadeId: 3, nome: 'Rodada 27', slug: 'rodada-27', tipoAcesso: CompeticaoTipoAcesso.FREE,
  valorInscricao: 0, rodadaInicio: 27, rodadaFim: 27,
  inicioInscricao: new Date('2026-09-01T00:00:00Z'), fimInscricao: new Date('2026-09-20T00:00:00Z'),
  dataInicio: new Date('2026-09-21T00:00:00Z'), dataFim: new Date('2026-09-28T00:00:00Z'),
  ...change,
});

const row = (change: Record<string, unknown> = {}) => {
  const result = {
  id: 7, ...baseDto(), descricao: null, tipoTaxaPlataforma: null, valorTaxaPlataforma: null as Prisma.Decimal | null,
  limiteTimesUsuario: null, limiteParticipantes: null, status: CompeticaoLigaStatus.RASCUNHO,
  visivelApp: false, destaque: false, criadoEm: new Date('2026-09-01T00:00:00Z'),
  atualizadoEm: new Date('2026-09-01T00:00:00Z'),
  ligaModalidade: { id: 3,
    liga: { id: 1, nome: 'Oculta', slug: 'oculta', status: 'INATIVA', visivelApp: false },
    modalidade: { id: 2, codigo: 'RODADA', nome: 'Rodada', ativa: false } },
  ...change,
  };
  return { ...result,
    valorInscricao: new Prisma.Decimal(String(result.valorInscricao)),
    valorTaxaPlataforma: result.valorTaxaPlataforma === null ? null : new Prisma.Decimal(String(result.valorTaxaPlataforma)),
  };
};

describe('AdminCompeticoesService', () => {
  const prisma = {
    $transaction: jest.fn(async (values: Array<Promise<unknown>>) => Promise.all(values)),
    ligaModalidade: { findUnique: jest.fn() },
    competicaoLiga: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    inscricaoTimeCompeticao: { count: jest.fn() },
  };
  const service = new AdminCompeticoesService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.ligaModalidade.findUnique.mockResolvedValue({ ativa: true });
    prisma.competicaoLiga.create.mockImplementation(async ({ data }) => row(data));
    prisma.competicaoLiga.findUnique.mockResolvedValue(row());
    prisma.competicaoLiga.update.mockImplementation(async ({ data }) => row(data));
    prisma.inscricaoTimeCompeticao.count.mockResolvedValue(0);
    prisma.competicaoLiga.count.mockResolvedValue(1);
    prisma.competicaoLiga.findMany.mockResolvedValue([row()]);
  });

  it('cria competicao valida e converte Decimal/datas na resposta', async () => {
    const result = await service.criar(baseDto());
    expect(result).toMatchObject({ id: 7, valorInscricao: 0, liga: { status: 'INATIVA' }, modalidade: { ativa: false } });
    expect(prisma.competicaoLiga.create).toHaveBeenCalled();
  });

  it('rejeita vinculo inexistente ou inativo', async () => {
    prisma.ligaModalidade.findUnique.mockResolvedValueOnce(null);
    await expect(service.criar(baseDto())).rejects.toBeInstanceOf(NotFoundException);
    prisma.ligaModalidade.findUnique.mockResolvedValueOnce({ ativa: false });
    await expect(service.criar(baseDto())).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['FREE com valor', { valorInscricao: 1 }],
    ['PAGO sem valor', { tipoAcesso: CompeticaoTipoAcesso.PAGO, valorInscricao: 0 }],
    ['rodadas invertidas', { rodadaInicio: 28, rodadaFim: 27 }],
    ['rodada nao positiva', { rodadaInicio: 0 }],
    ['datas invertidas', { dataInicio: new Date('2026-10-02Z'), dataFim: new Date('2026-10-01Z') }],
    ['inscricoes invertidas', { inicioInscricao: new Date('2026-09-20Z'), fimInscricao: new Date('2026-09-19Z') }],
    ['inscricao apos inicio', { fimInscricao: new Date('2026-09-22Z') }],
    ['taxa sem tipo', { valorTaxaPlataforma: 10 }],
    ['tipo sem taxa', { tipoTaxaPlataforma: 'VALOR_FIXO' }],
    ['percentual acima de 100', { tipoTaxaPlataforma: 'PERCENTUAL', valorTaxaPlataforma: 101 }],
    ['limite invalido', { limiteParticipantes: 0 }],
  ])('rejeita %s', async (_nome, change) => {
    await expect(service.criar(baseDto(change as Partial<CriarAdminCompeticaoDto>))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('traduz slug duplicado para conflito', async () => {
    prisma.competicaoLiga.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicado', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['SLUG'] },
    }));
    await expect(service.criar(baseDto())).rejects.toBeInstanceOf(ConflictException);
  });

  it('aplica PATCH parcial e valida o estado final combinado', async () => {
    await expect(service.atualizar(7, { descricao: 'Novo texto' })).resolves.toMatchObject({ descricao: 'Novo texto' });
    await expect(service.atualizar(7, { dataInicio: new Date('2026-09-19T00:00:00Z') }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('bloqueia alteracao estrutural com inscricoes, mas permite apresentacao', async () => {
    prisma.inscricaoTimeCompeticao.count.mockResolvedValue(2);
    await expect(service.atualizar(7, { rodadaFim: 28 })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.atualizar(7, { descricao: 'Seguro', visivelApp: true, destaque: true }))
      .resolves.toMatchObject({ descricao: 'Seguro', visivelApp: true, destaque: true });
  });

  it('impede transicoes terminais invalidas', async () => {
    prisma.competicaoLiga.findUnique.mockResolvedValueOnce(row({ status: CompeticaoLigaStatus.CANCELADA }));
    await expect(service.atualizar(7, { status: CompeticaoLigaStatus.INSCRICOES_ABERTAS }))
      .rejects.toBeInstanceOf(ConflictException);
    prisma.competicaoLiga.findUnique.mockResolvedValueOnce(row({ status: CompeticaoLigaStatus.ENCERRADA }));
    await expect(service.atualizar(7, { status: CompeticaoLigaStatus.INSCRICOES_ABERTAS }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('pagina e filtra sem aplicar visibilidade publica implicita', async () => {
    const result = await service.listar({ pagina: 2, limite: 10, liga: 1, modalidade: 2,
      status: CompeticaoLigaStatus.RASCUNHO, visivel: false, busca: 'rodada' });
    const options = prisma.competicaoLiga.findMany.mock.calls[0][0];
    expect(options).toMatchObject({ skip: 10, take: 10, where: { visivelApp: false, status: 'RASCUNHO',
      ligaModalidade: { ligaId: 1, modalidadeId: 2 } } });
    expect(options.where.OR).toHaveLength(2);
    expect(result).toMatchObject({ itens: [{ visivelApp: false }], paginacao: { pagina: 2, total: 1 } });
  });
});

describe('AdminLigasService', () => {
  const prisma = { liga: { findMany: jest.fn(), findUnique: jest.fn() }, ligaModalidade: { findMany: jest.fn() } };
  const service = new AdminLigasService(prisma as unknown as PrismaService);

  it('lista liga inativa/invisivel e todos os vinculos', async () => {
    prisma.liga.findMany.mockResolvedValue([{ id: 1, nome: 'Oculta', slug: 'oculta', tipo: 'OFICIAL', status: 'INATIVA', visivelApp: false, imagemUrl: null }]);
    expect(await service.listar()).toEqual([expect.objectContaining({ status: 'INATIVA', visivelApp: false })]);
    expect(prisma.liga.findMany.mock.calls[0][0]).not.toHaveProperty('where');
    prisma.liga.findUnique.mockResolvedValue({ id: 1 });
    prisma.ligaModalidade.findMany.mockResolvedValue([{ id: 3, modalidadeId: 2, ativa: false, ordem: 1,
      modalidade: { codigo: 'RODADA', nome: 'Rodada' } }]);
    expect(await service.listarModalidades(1)).toEqual([{ ligaModalidadeId: 3, modalidadeId: 2,
      codigo: 'RODADA', nome: 'Rodada', ativa: false, ordem: 1 }]);
  });
});
