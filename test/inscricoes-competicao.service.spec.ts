import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InscricoesCompeticaoService } from '../src/ligas-competicoes/inscricoes-competicao.service';
import { PrismaService } from '../src/prisma/prisma.service';

const now = new Date('2026-09-14T12:00:00Z');
const competicao = (overrides: Record<string, unknown> = {}) => ({
  visivelApp: true, tipoAcesso: 'FREE', valorInscricao: new Prisma.Decimal(0), status: 'INSCRICOES_ABERTAS',
  inicioInscricao: new Date('2026-09-01T00:00:00Z'), fimInscricao: new Date('2026-09-30T23:59:59Z'),
  limiteTimesUsuario: 30, limiteParticipantes: null,
  ligaModalidade: { ativa: true, liga: { status: 'ATIVA' }, modalidade: { ativa: true } }, ...overrides,
});
const inscricao = () => ({
  id: 8, timeIdCartola: 123, nomeTime: 'Time salvo', nomeCartoleiro: 'Cartoleiro', escudoUrl: 'https://escudo.test/1.png',
  statusInscricao: 'ATIVA', pontuacao: null, posicao: null, posicaoAnterior: null,
  premioApurado: null, dataInscricao: now, valorInscricao: new Prisma.Decimal(0),
});

describe('InscricoesCompeticaoService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    competicaoLiga: { findUnique: jest.fn() },
    timeUsuario: { findUnique: jest.fn() },
    inscricaoTimeCompeticao: { findUnique: jest.fn(), count: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    competicaoLiga: { findUnique: jest.fn(), findFirst: jest.fn() },
    inscricaoTimeCompeticao: { findMany: jest.fn() },
  };
  const service = new InscricoesCompeticaoService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    tx.$queryRaw.mockResolvedValue([{ ID: 1 }]);
    tx.competicaoLiga.findUnique.mockResolvedValue(competicao());
    tx.timeUsuario.findUnique.mockResolvedValue({ timeId: 123, nome: 'Time salvo', nomeCartola: 'Cartoleiro', urlEscudoPng: 'https://escudo.test/1.png' });
    tx.inscricaoTimeCompeticao.findUnique.mockResolvedValue(null);
    tx.inscricaoTimeCompeticao.count.mockResolvedValue(0);
    tx.inscricaoTimeCompeticao.create.mockResolvedValue(inscricao());
    prisma.competicaoLiga.findUnique.mockResolvedValue({ id: 1 });
    prisma.competicaoLiga.findFirst.mockResolvedValue({ id: 1 });
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([]);
  });
  afterEach(() => jest.useRealTimers());

  it('inscreve time FREE numa transacao com bloqueio da competicao', async () => {
    const result = await service.criar(1, 10, 123);
    expect(result).toMatchObject({ id: 8, nomeTime: 'Time salvo', valorInscricao: 0, statusInscricao: 'ATIVA' });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.competicaoLiga.findUnique.mock.invocationCallOrder[0]);
  });

  it('retorna 404 quando a competicao nao existe', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.criar(99, 10, 123)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.inscricaoTimeCompeticao.create).not.toHaveBeenCalled();
  });

  it.each([
    ['PAGO', { tipoAcesso: 'PAGO' }], ['invisivel', { visivelApp: false }],
    ['status fechado', { status: 'INSCRICOES_ENCERRADAS' }],
    ['FREE com valor inconsistente', { valorInscricao: new Prisma.Decimal(1) }],
  ])('rejeita competicao %s', async (_label, change) => {
    tx.competicaoLiga.findUnique.mockResolvedValue(competicao(change));
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.inscricaoTimeCompeticao.create).not.toHaveBeenCalled();
  });

  it.each([
    ['antes', { inicioInscricao: new Date('2026-09-15T00:00:00Z') }],
    ['depois', { fimInscricao: new Date('2026-09-13T23:59:59Z') }],
  ])('rejeita janela de inscricao %s', async (_label, change) => {
    tx.competicaoLiga.findUnique.mockResolvedValue(competicao(change));
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(ConflictException);
  });

  it('aceita janela sem limites de data', async () => {
    tx.competicaoLiga.findUnique.mockResolvedValue(competicao({ inicioInscricao: null, fimInscricao: null }));
    await expect(service.criar(1, 10, 123)).resolves.toMatchObject({ id: 8 });
  });

  it.each([
    ['liga', { ativa: true, liga: { status: 'INATIVA' }, modalidade: { ativa: true } }],
    ['vinculo', { ativa: false, liga: { status: 'ATIVA' }, modalidade: { ativa: true } }],
    ['modalidade', { ativa: true, liga: { status: 'ATIVA' }, modalidade: { ativa: false } }],
  ])('rejeita %s inativo', async (_label, ligaModalidade) => {
    tx.competicaoLiga.findUnique.mockResolvedValue(competicao({ ligaModalidade }));
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(ConflictException);
  });

  it('exige que o time esteja salvo para o usuario autenticado', async () => {
    tx.timeUsuario.findUnique.mockResolvedValue(null);
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.timeUsuario.findUnique).toHaveBeenCalledWith({ where: { usuarioId_timeId: { usuarioId: 10, timeId: 123 } }, select: expect.any(Object) });
  });

  it('impede reinscricao do mesmo time, inclusive se a anterior foi cancelada', async () => {
    tx.inscricaoTimeCompeticao.findUnique.mockResolvedValue({ id: 7 });
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.inscricaoTimeCompeticao.create).not.toHaveBeenCalled();
  });

  it('respeita limite de times ativos por usuario', async () => {
    tx.competicaoLiga.findUnique.mockResolvedValue(competicao({ limiteTimesUsuario: 2 }));
    tx.inscricaoTimeCompeticao.count.mockResolvedValue(2);
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.inscricaoTimeCompeticao.count).toHaveBeenCalledWith({ where: { competicaoLigaId: 1, usuarioId: 10, statusInscricao: 'ATIVA' } });
  });

  it('respeita limite total de participantes ativos', async () => {
    tx.competicaoLiga.findUnique.mockResolvedValue(competicao({ limiteTimesUsuario: null, limiteParticipantes: 1 }));
    tx.inscricaoTimeCompeticao.count.mockResolvedValue(1);
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.inscricaoTimeCompeticao.count).toHaveBeenCalledWith({ where: { competicaoLigaId: 1, statusInscricao: 'ATIVA' } });
  });

  it('salva snapshot e copia valor da competicao, sem FK para TIME_USUARIO', async () => {
    await service.criar(1, 10, 123);
    expect(tx.inscricaoTimeCompeticao.create).toHaveBeenCalledWith({
      data: { competicaoLigaId: 1, usuarioId: 10, timeIdCartola: 123, nomeTime: 'Time salvo',
        nomeCartoleiro: 'Cartoleiro', escudoUrl: 'https://escudo.test/1.png', valorInscricao: new Prisma.Decimal(0),
        statusInscricao: 'ATIVA', dataInscricao: now }, select: expect.any(Object),
    });
    expect(prisma).not.toHaveProperty('carteira');
  });

  it('traduz conflito UNIQUE concorrente para 409 amigavel', async () => {
    tx.inscricaoTimeCompeticao.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }));
    await expect(service.criar(1, 10, 123)).rejects.toThrow('Este time ja esta inscrito nesta competicao.');
  });

  it('traduz conflito de transacao concorrente para 409', async () => {
    tx.inscricaoTimeCompeticao.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: '5.22.0' }));
    await expect(service.criar(1, 10, 123)).rejects.toBeInstanceOf(ConflictException);
  });

  it('lista somente inscricoes do usuario com ordenacao estavel', async () => {
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([inscricao()]);
    expect(await service.minhas(1, 10)).toMatchObject([{ id: 8, dataInscricao: now.toISOString() }]);
    expect(prisma.inscricaoTimeCompeticao.findMany).toHaveBeenCalledWith({ where: { competicaoLigaId: 1, usuarioId: 10 },
      select: expect.any(Object), orderBy: [{ dataInscricao: 'asc' }, { id: 'asc' }] });
  });

  it('nao lista inscricoes de outro usuario em minhas', async () => {
    await service.minhas(1, 99);
    expect(prisma.inscricaoTimeCompeticao.findMany.mock.calls[0][0].where.usuarioId).toBe(99);
  });

  it('participantes publicos usam apenas snapshot de inscricoes ativas', async () => {
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([{ id: 8, nomeTime: 'Snapshot', nomeCartoleiro: null,
      escudoUrl: null, pontuacao: new Prisma.Decimal('12.50'), posicao: null, posicaoAnterior: null }]);
    expect(await service.participantes(1)).toEqual([{ id: 8, nomeTime: 'Snapshot', nomeCartoleiro: null,
      escudoUrl: null, pontuacao: 12.5, posicao: null, posicaoAnterior: null }]);
    expect(prisma.inscricaoTimeCompeticao.findMany.mock.calls[0][0]).toMatchObject({ where: { competicaoLigaId: 1, statusInscricao: 'ATIVA' },
      orderBy: [{ posicao: { sort: 'asc', nulls: 'last' } }, { dataInscricao: 'asc' }, { id: 'asc' }] });
    expect(prisma.inscricaoTimeCompeticao.findMany.mock.calls[0][0].select).not.toHaveProperty('timeUsuario');
    expect(tx.timeUsuario.findUnique).not.toHaveBeenCalled();
  });

  it('nao expoe participantes de competicao oculta', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(null);
    await expect(service.participantes(1)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.inscricaoTimeCompeticao.findMany).not.toHaveBeenCalled();
  });
});
