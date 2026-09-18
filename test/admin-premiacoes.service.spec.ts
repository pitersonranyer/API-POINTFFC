import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CompeticaoLigaStatus, PremiacaoCompeticaoTipo, Prisma } from '@prisma/client';
import { AdminPremiacoesService } from '../src/admin/admin-premiacoes.service';
import { AdminPremiacaoInputDto } from '../src/admin/dto/admin-premiacoes.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const fixa = (change: Partial<AdminPremiacaoInputDto> = {}): AdminPremiacaoInputDto => ({
  posicaoInicio: 1, posicaoFim: 1, tipoPremiacao: PremiacaoCompeticaoTipo.VALOR_FIXO,
  valor: 100, percentual: null, ...change,
});
const percentual = (change: Partial<AdminPremiacaoInputDto> = {}): AdminPremiacaoInputDto => ({
  posicaoInicio: 1, posicaoFim: 1, tipoPremiacao: PremiacaoCompeticaoTipo.PERCENTUAL,
  valor: null, percentual: 50, ...change,
});
const row = (input: AdminPremiacaoInputDto, id = 1) => ({
  id, competicaoLigaId: 7, posicaoInicio: input.posicaoInicio, posicaoFim: input.posicaoFim,
  tipoPremiacao: input.tipoPremiacao,
  valor: input.valor === null || input.valor === undefined ? null : new Prisma.Decimal(input.valor),
  percentual: input.percentual === null || input.percentual === undefined ? null : new Prisma.Decimal(input.percentual),
  ordem: input.ordem ?? id - 1,
  criadoEm: new Date('2026-09-18T00:00:00Z'), atualizadoEm: new Date('2026-09-18T00:00:00Z'),
});

describe('AdminPremiacoesService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    competicaoLiga: { findUnique: jest.fn() },
    premiacaoCompeticao: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    competicaoLiga: { findUnique: jest.fn() },
    premiacaoCompeticao: { findMany: jest.fn() },
  };
  const service = new AdminPremiacoesService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.competicaoLiga.findUnique.mockResolvedValue({ id: 7 });
    prisma.premiacaoCompeticao.findMany.mockResolvedValue([row(fixa())]);
    tx.$queryRaw.mockResolvedValue([{ ID: 7 }]);
    tx.competicaoLiga.findUnique.mockResolvedValue({ status: CompeticaoLigaStatus.RASCUNHO, limiteParticipantes: null });
    tx.premiacaoCompeticao.deleteMany.mockResolvedValue({ count: 1 });
    tx.premiacaoCompeticao.createMany.mockResolvedValue({ count: 1 });
    tx.premiacaoCompeticao.findMany.mockResolvedValue([row(fixa())]);
  });

  it('GET valida a competicao e retorna IDs, valores convertidos e ordenacao administrativa', async () => {
    await expect(service.listar(7)).resolves.toEqual([expect.objectContaining({
      id: 1, competicaoLigaId: 7, tipoPremiacao: 'VALOR_FIXO', valor: 100,
    })]);
    expect(prisma.premiacaoCompeticao.findMany.mock.calls[0][0].orderBy)
      .toEqual([{ posicaoInicio: 'asc' }, { ordem: 'asc' }, { id: 'asc' }]);
    prisma.competicaoLiga.findUnique.mockResolvedValueOnce(null);
    await expect(service.listar(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['VALOR_FIXO', [fixa()]],
    ['PERCENTUAL', [percentual()]],
    ['mista', [fixa(), percentual({ posicaoInicio: 3, posicaoFim: 3, percentual: 25 })]],
    ['nao continua', [fixa(), fixa({ posicaoInicio: 5, posicaoFim: 5 })]],
    ['percentual igual a 100', [percentual({ percentual: 60 }), percentual({ posicaoInicio: 2, posicaoFim: 2, percentual: 40 })]],
    ['percentual menor que 100', [percentual({ percentual: 30 }), percentual({ posicaoInicio: 2, posicaoFim: 2, percentual: 20 })]],
  ])('aceita grade valida %s', async (_nome, grade) => {
    tx.premiacaoCompeticao.findMany.mockResolvedValue(grade.map((item, index) => row(item, index + 1)));
    await expect(service.substituir(7, grade)).resolves.toHaveLength(grade.length);
    expect(tx.premiacaoCompeticao.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.premiacaoCompeticao.createMany).toHaveBeenCalledTimes(1);
  });

  it('permite grade vazia e remove tudo dentro da transacao', async () => {
    tx.premiacaoCompeticao.findMany.mockResolvedValue([]);
    await expect(service.substituir(7, [])).resolves.toEqual([]);
    expect(tx.premiacaoCompeticao.deleteMany).toHaveBeenCalledWith({ where: { competicaoLigaId: 7 } });
    expect(tx.premiacaoCompeticao.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['posicao zero', [fixa({ posicaoInicio: 0 })]],
    ['fim menor que inicio', [fixa({ posicaoInicio: 2, posicaoFim: 1 })]],
    ['sobreposicao', [fixa({ posicaoInicio: 1, posicaoFim: 3 }), fixa({ posicaoInicio: 3, posicaoFim: 5 })]],
    ['fixo sem valor', [fixa({ valor: null })]],
    ['fixo com percentual', [fixa({ percentual: 10 })]],
    ['percentual ausente', [percentual({ percentual: null })]],
    ['percentual com valor', [percentual({ valor: 10 })]],
    ['percentual individual acima de 100', [percentual({ percentual: 101 })]],
    ['soma percentual acima de 100', [percentual({ percentual: 60 }), percentual({ posicaoInicio: 2, posicaoFim: 2, percentual: 41 })]],
  ])('rejeita %s antes de remover a grade anterior', async (_nome, grade) => {
    await expect(service.substituir(7, grade)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.premiacaoCompeticao.deleteMany).not.toHaveBeenCalled();
    expect(tx.premiacaoCompeticao.createMany).not.toHaveBeenCalled();
  });

  it('respeita limiteParticipantes e nao inventa limite quando nulo', async () => {
    tx.competicaoLiga.findUnique.mockResolvedValueOnce({ status: 'RASCUNHO', limiteParticipantes: 10 });
    await expect(service.substituir(7, [fixa({ posicaoInicio: 11, posicaoFim: 11 })]))
      .rejects.toBeInstanceOf(BadRequestException);
    tx.competicaoLiga.findUnique.mockResolvedValueOnce({ status: 'RASCUNHO', limiteParticipantes: null });
    tx.premiacaoCompeticao.findMany.mockResolvedValueOnce([row(fixa({ posicaoInicio: 999, posicaoFim: 999 }))]);
    await expect(service.substituir(7, [fixa({ posicaoInicio: 999, posicaoFim: 999 })])).resolves.toHaveLength(1);
  });

  it.each([CompeticaoLigaStatus.RASCUNHO, CompeticaoLigaStatus.INSCRICOES_ABERTAS])
  ('permite editar no estado %s mesmo sem consultar inscricoes', async status => {
    tx.competicaoLiga.findUnique.mockResolvedValueOnce({ status, limiteParticipantes: null });
    await expect(service.substituir(7, [fixa()])).resolves.toHaveLength(1);
    expect(tx).not.toHaveProperty('inscricaoTimeCompeticao');
  });

  it.each([
    CompeticaoLigaStatus.INSCRICOES_ENCERRADAS, CompeticaoLigaStatus.EM_ANDAMENTO,
    CompeticaoLigaStatus.ENCERRADA, CompeticaoLigaStatus.CANCELADA,
  ])('bloqueia edicao no estado %s sem remover dados', async status => {
    tx.competicaoLiga.findUnique.mockResolvedValueOnce({ status, limiteParticipantes: null });
    await expect(service.substituir(7, [])).rejects.toBeInstanceOf(ConflictException);
    expect(tx.premiacaoCompeticao.deleteMany).not.toHaveBeenCalled();
  });

  it('retorna 404 sob o lock quando a competicao nao existe', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.substituir(999, [])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serializa e executa delete/create/leitura na mesma transacao, com retorno ordenado', async () => {
    const grade = [fixa({ posicaoInicio: 5, posicaoFim: 5 }), fixa({ posicaoInicio: 1, posicaoFim: 1 })];
    tx.premiacaoCompeticao.findMany.mockResolvedValueOnce([row(grade[1], 2), row(grade[0], 1)]);
    const result = await service.substituir(7, grade);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.premiacaoCompeticao.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.premiacaoCompeticao.createMany.mock.invocationCallOrder[0]);
    expect(tx.premiacaoCompeticao.createMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.premiacaoCompeticao.findMany.mock.invocationCallOrder[0]);
    expect(tx.premiacaoCompeticao.findMany.mock.calls[0][0].orderBy)
      .toEqual([{ posicaoInicio: 'asc' }, { ordem: 'asc' }, { id: 'asc' }]);
    expect(result.map(item => item.posicaoInicio)).toEqual([1, 5]);
  });

  it('propaga falha de persistencia para rollback da transacao', async () => {
    tx.premiacaoCompeticao.createMany.mockRejectedValueOnce(new Error('falha'));
    await expect(service.substituir(7, [fixa()])).rejects.toThrow('falha');
    expect(tx.premiacaoCompeticao.findMany).not.toHaveBeenCalled();
  });
});
