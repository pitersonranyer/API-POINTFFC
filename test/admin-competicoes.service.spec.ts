import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CompeticaoLigaStatus, CompeticaoTipoAcesso, Prisma } from '@prisma/client';
import { AdminCompeticoesService } from '../src/admin/admin-competicoes.service';
import { AdminLigasService } from '../src/admin/admin-ligas.service';
import { CriarAdminCompeticaoDto, DuplicarAdminCompeticaoDto } from '../src/admin/dto/admin-competicoes.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const baseDto = (change: Partial<CriarAdminCompeticaoDto> = {}): CriarAdminCompeticaoDto => ({
  ligaModalidadeId: 3, nome: 'Rodada 27', slug: 'rodada-27', tipoAcesso: CompeticaoTipoAcesso.FREE,
  valorInscricao: 0, rodadaInicio: 27, rodadaFim: 27,
  inicioInscricao: new Date('2026-09-01T00:00:00Z'), fimInscricao: new Date('2026-09-20T00:00:00Z'),
  dataInicio: new Date('2026-09-21T00:00:00Z'), dataFim: new Date('2026-09-28T00:00:00Z'),
  ...change,
});

const duplicarDto = (change: Partial<DuplicarAdminCompeticaoDto> = {}): DuplicarAdminCompeticaoDto => ({
  nome: 'Rodada 28', slug: 'rodada-28', rodadaInicio: 28, rodadaFim: 28,
  inicioInscricao: new Date('2026-09-22T00:00:00Z'), fimInscricao: new Date('2026-09-29T00:00:00Z'),
  dataInicio: new Date('2026-09-30T00:00:00Z'), dataFim: new Date('2026-10-07T00:00:00Z'),
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
  const tx = {
    ligaModalidade: { findUnique: jest.fn() },
    competicaoLiga: { findUnique: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (input: Array<Promise<unknown>> | ((client: typeof tx) => Promise<unknown>)) =>
      typeof input === 'function' ? input(tx) : Promise.all(input)),
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
    tx.ligaModalidade.findUnique.mockResolvedValue({ ativa: true });
    tx.competicaoLiga.findUnique.mockResolvedValue(row({
      status: CompeticaoLigaStatus.ENCERRADA, descricao: 'Modelo', tipoTaxaPlataforma: 'PERCENTUAL',
      valorTaxaPlataforma: new Prisma.Decimal(10), limiteTimesUsuario: 3, limiteParticipantes: 100,
      visivelApp: true, destaque: true,
    }));
    tx.competicaoLiga.create.mockImplementation(async ({ data }) => row({ ...data, id: 8 }));
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

  describe('PATCH com inconsistencia temporal historica', () => {
    beforeEach(() => {
      prisma.competicaoLiga.findUnique.mockResolvedValue(row({
        fimInscricao: new Date('2026-09-22T00:00:00Z'),
      }));
    });

    it.each([
      { status: CompeticaoLigaStatus.ENCERRADA },
      { descricao: 'Texto atualizado' },
    ])('permite edicao sem datas: %j', async dto => {
      prisma.inscricaoTimeCompeticao.count.mockResolvedValue(2);
      await expect(service.atualizar(7, dto)).resolves.toMatchObject({
        ...dto, fimInscricao: '2026-09-22T00:00:00.000Z', dataInicio: '2026-09-21T00:00:00.000Z',
      });
      expect(prisma.competicaoLiga.update).toHaveBeenCalledTimes(1);
    });

    it.each([
      { dataInicio: new Date('2026-09-20T00:00:00Z') },
      { dataFim: new Date('2026-09-29T00:00:00Z') },
      { inicioInscricao: new Date('2026-09-02T00:00:00Z') },
      { fimInscricao: new Date('2026-09-23T00:00:00Z') },
      { dataFim: null },
      { dataInicio: new Date('2026-09-21T00:00:00Z') },
    ])('valida todo o conjunto quando uma data esta presente: %j', async dto => {
      await expect(service.atualizar(7, dto))
        .rejects.toThrow('fimInscricao nao pode ser posterior a dataInicio.');
      expect(prisma.competicaoLiga.update).not.toHaveBeenCalled();
    });

    it('permite corrigir a data usando as demais datas preservadas', async () => {
      await expect(service.atualizar(7, { dataInicio: new Date('2026-09-23T00:00:00Z') }))
        .resolves.toMatchObject({ dataInicio: '2026-09-23T00:00:00.000Z',
          fimInscricao: '2026-09-22T00:00:00.000Z', dataFim: '2026-09-28T00:00:00.000Z' });
      expect(prisma.competicaoLiga.update).toHaveBeenCalledTimes(1);
    });

    it.each([
      [{ valorInscricao: 1 }, 'Competicao FREE deve ter valorInscricao igual a zero.'],
      [{ rodadaFim: 26 }, 'rodadaFim deve ser maior ou igual a rodadaInicio.'],
      [{ limiteParticipantes: 0 }, 'Limites devem ser maiores que zero.'],
      [{ valorTaxaPlataforma: 10 }, 'Tipo e valor da taxa da plataforma devem ser informados juntos.'],
    ] as const)('preserva validacoes nao temporais: %j', async (dto, mensagem) => {
      await expect(service.atualizar(7, dto)).rejects.toThrow(mensagem);
      expect(prisma.competicaoLiga.update).not.toHaveBeenCalled();
    });

    it('preserva bloqueios estruturais e de status com inscricoes ativas', async () => {
      prisma.inscricaoTimeCompeticao.count.mockResolvedValue(2);
      await expect(service.atualizar(7, { rodadaFim: 28 })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.atualizar(7, { status: CompeticaoLigaStatus.CANCELADA }))
        .rejects.toBeInstanceOf(ConflictException);
      expect(prisma.competicaoLiga.update).not.toHaveBeenCalled();
    });

    it.each([CompeticaoLigaStatus.CANCELADA, CompeticaoLigaStatus.ENCERRADA])(
      'preserva restricoes de transicao de %s', async status => {
        prisma.competicaoLiga.findUnique.mockResolvedValue(row({
          status, fimInscricao: new Date('2026-09-22T00:00:00Z'),
        }));
        await expect(service.atualizar(7, { status: CompeticaoLigaStatus.INSCRICOES_ABERTAS }))
          .rejects.toBeInstanceOf(ConflictException);
        expect(prisma.competicaoLiga.update).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    [{ dataFim: new Date('2026-09-20T00:00:00Z') }, 'dataFim deve ser maior ou igual a dataInicio.'],
    [{ inicioInscricao: new Date('2026-09-21T00:00:00Z') }, 'fimInscricao deve ser maior ou igual a inicioInscricao.'],
  ])('preserva as demais regras temporais no PATCH: %j', async (dto, mensagem) => {
    await expect(service.atualizar(7, dto as Partial<CriarAdminCompeticaoDto>)).rejects.toThrow(mensagem as string);
    expect(prisma.competicaoLiga.update).not.toHaveBeenCalled();
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

  it('duplica origem encerrada herdando estrutura, mas usando novos dados e status RASCUNHO', async () => {
    const dto = duplicarDto();
    const result = await service.duplicar(7, dto);
    expect(result).toMatchObject({ id: 8, nome: 'Rodada 28', slug: 'rodada-28', rodadaInicio: 28, rodadaFim: 28,
      descricao: 'Modelo', tipoAcesso: 'FREE', valorInscricao: 0,
      tipoTaxaPlataforma: 'PERCENTUAL', valorTaxaPlataforma: 10,
      limiteTimesUsuario: 3, limiteParticipantes: 100, visivelApp: true, destaque: true,
      status: CompeticaoLigaStatus.RASCUNHO });
    const data = tx.competicaoLiga.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ dataInicio: dto.dataInicio, dataFim: dto.dataFim,
      inicioInscricao: dto.inicioInscricao, fimInscricao: dto.fimInscricao });
    expect(prisma.competicaoLiga.update).not.toHaveBeenCalled();
    expect(prisma.inscricaoTimeCompeticao.count).not.toHaveBeenCalled();
    expect(tx).not.toHaveProperty('premiacaoCompeticao');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('retorna 404 sem criar quando a origem nao existe', async () => {
    tx.competicaoLiga.findUnique.mockResolvedValueOnce(null);
    await expect(service.duplicar(999, duplicarDto())).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.competicaoLiga.create).not.toHaveBeenCalled();
  });

  it('preserva configuracao PAGO e limites', async () => {
    tx.competicaoLiga.findUnique.mockResolvedValueOnce(row({ tipoAcesso: 'PAGO', valorInscricao: 25,
      limiteTimesUsuario: 2, limiteParticipantes: 50, tipoTaxaPlataforma: 'VALOR_FIXO',
      valorTaxaPlataforma: new Prisma.Decimal(3) }));
    await service.duplicar(7, duplicarDto());
    expect(tx.competicaoLiga.create.mock.calls[0][0].data).toMatchObject({
      tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal(25), limiteTimesUsuario: 2,
      limiteParticipantes: 50, tipoTaxaPlataforma: 'VALOR_FIXO', valorTaxaPlataforma: new Prisma.Decimal(3),
    });
  });

  it('reutiliza validacao de datas e nao persiste duplicacao invalida', async () => {
    await expect(service.duplicar(7, duplicarDto({ dataFim: new Date('2026-09-29T00:00:00Z') })))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tx.competicaoLiga.create).not.toHaveBeenCalled();
  });

  it('traduz slug duplicado na duplicacao para 409', async () => {
    tx.competicaoLiga.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicado', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['SLUG'] },
    }));
    await expect(service.duplicar(7, duplicarDto())).rejects.toBeInstanceOf(ConflictException);
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
