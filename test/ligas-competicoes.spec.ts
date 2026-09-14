import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { CompeticaoLigaStatus, Prisma } from '@prisma/client';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { CompeticoesController, LigasController } from '../src/ligas-competicoes/ligas-competicoes.controller';
import { LigasCompeticoesService } from '../src/ligas-competicoes/ligas-competicoes.service';
import { PrismaService } from '../src/prisma/prisma.service';

const modalidade = { codigo: 'RODADA', nome: 'Rodada' };
const liga = { id: 2, nome: 'POINT FFC', slug: 'point-ffc', descricao: null, imagemUrl: null, tipo: 'OFICIAL' };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1, nome: 'POINT FFC - Rodada 27', slug: 'point-ffc-rodada-27', descricao: null,
  tipoAcesso: 'FREE', valorInscricao: new Prisma.Decimal(0), rodadaInicio: 27, rodadaFim: 27,
  inicioInscricao: new Date('2026-09-01T00:00:00Z'), fimInscricao: new Date('2026-09-30T23:59:59Z'),
  dataInicio: new Date('2026-10-01T00:00:00Z'), dataFim: new Date('2026-10-07T23:59:59Z'),
  limiteTimesUsuario: 30, limiteParticipantes: null, status: 'INSCRICOES_ABERTAS', destaque: true,
  ligaModalidade: { modalidade, liga }, premiacoes: [], ...overrides,
});

describe('Ligas e competicoes - leitura publica', () => {
  const prisma = {
    liga: { findFirst: jest.fn() },
    competicaoLiga: { findMany: jest.fn(), findFirst: jest.fn() },
    inscricaoTimeCompeticao: { count: jest.fn() },
  };
  const service = new LigasCompeticoesService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.liga.findFirst.mockResolvedValue({ ...liga, modalidades: [{ modalidade }] });
    prisma.competicaoLiga.findMany.mockResolvedValue([row()]);
    prisma.competicaoLiga.findFirst.mockResolvedValue(row());
    prisma.inscricaoTimeCompeticao.count.mockResolvedValue(0);
  });

  it('busca a liga pelo slug, exigindo status ativo e visibilidade', async () => {
    expect(await service.buscarLiga('point-ffc')).toEqual({ ...liga, modalidades: [modalidade] });
    expect(prisma.liga.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: 'point-ffc', status: 'ATIVA', visivelApp: true } }));
  });

  it('retorna 404 para liga inexistente ou indisponivel', async () => {
    prisma.liga.findFirst.mockResolvedValue(null);
    await expect(service.buscarLiga('inexistente')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.listarCompeticoes('inexistente', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ordena modalidades por ORDEM e desempata pelo ID', async () => {
    const response = await service.buscarLiga('point-ffc');
    expect(response.modalidades).toEqual([modalidade]);
    expect(prisma.liga.findFirst.mock.calls[0][0].select.modalidades.orderBy).toEqual([{ ordem: 'asc' }, { id: 'asc' }]);
  });

  it('exclui vinculos e modalidades inativos', async () => {
    await service.buscarLiga('point-ffc');
    expect(prisma.liga.findFirst.mock.calls[0][0].select.modalidades.where).toEqual({ ativa: true, modalidade: { ativa: true } });
  });

  it('lista competicoes pela liga via LIGA_MODALIDADE e ordena cards', async () => {
    prisma.liga.findFirst.mockResolvedValue({ id: 2 });
    const result = await service.listarCompeticoes('point-ffc', {});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ nome: 'POINT FFC - Rodada 27', valorInscricao: 0, modalidade });
    expect(result[0]).not.toHaveProperty('ligaModalidade');
    expect(prisma.competicaoLiga.findMany.mock.calls[0][0].where.ligaModalidade).toMatchObject({ ligaId: 2, ativa: true, modalidade: { ativa: true } });
    expect(prisma.competicaoLiga.findMany.mock.calls[0][0].orderBy).toEqual([
      { destaque: 'desc' }, { valorInscricao: 'asc' }, { nome: 'asc' }, { id: 'asc' },
    ]);
  });

  it('filtra pelo codigo da modalidade', async () => {
    prisma.liga.findFirst.mockResolvedValue({ id: 2 });
    await service.listarCompeticoes('point-ffc', { modalidade: 'RODADA' });
    expect(prisma.competicaoLiga.findMany.mock.calls[0][0].where.ligaModalidade.modalidade).toEqual({ ativa: true, codigo: 'RODADA' });
  });

  it('filtra rodada inclusivamente pela faixa e exclui faixas nulas', async () => {
    prisma.liga.findFirst.mockResolvedValue({ id: 2 });
    await service.listarCompeticoes('point-ffc', { rodada: 27 });
    expect(prisma.competicaoLiga.findMany.mock.calls[0][0].where).toMatchObject({ rodadaInicio: { lte: 27 }, rodadaFim: { gte: 27 } });
    jest.clearAllMocks();
    prisma.liga.findFirst.mockResolvedValue({ id: 2 });
    await service.listarCompeticoes('point-ffc', {});
    expect(prisma.competicaoLiga.findMany.mock.calls[0][0].where).not.toHaveProperty('rodadaInicio');
  });

  it('filtra status quando informado', async () => {
    prisma.liga.findFirst.mockResolvedValue({ id: 2 });
    await service.listarCompeticoes('point-ffc', { status: CompeticaoLigaStatus.INSCRICOES_ABERTAS });
    expect(prisma.competicaoLiga.findMany.mock.calls[0][0].where.status).toBe('INSCRICOES_ABERTAS');
  });

  it('nao inclui competicoes invisiveis na listagem publica', async () => {
    prisma.liga.findFirst.mockResolvedValue({ id: 2 });
    await service.listarCompeticoes('point-ffc', {});
    expect(prisma.competicaoLiga.findMany.mock.calls[0][0].where.visivelApp).toBe(true);
  });

  it('retorna detalhe com liga, modalidade, datas e premiação vazia', async () => {
    const result = await service.buscarCompeticao(1);
    expect(result).toMatchObject({ id: 1, liga: { id: 2, slug: 'point-ffc' }, modalidade, premiacao: [], quantidadeInscritos: 0 });
    expect(result.inicioInscricao).toBe('2026-09-01T00:00:00.000Z');
    expect(result).not.toHaveProperty('ligaModalidade');
  });

  it('conta apenas inscricoes ativas sem consultar carteira', async () => {
    prisma.inscricaoTimeCompeticao.count.mockResolvedValue(3);
    expect((await service.buscarCompeticao(1)).quantidadeInscritos).toBe(3);
    expect(prisma.inscricaoTimeCompeticao.count).toHaveBeenCalledWith({ where: { competicaoLigaId: 1, statusInscricao: 'ATIVA' } });
  });

  it('oculta detalhe de competicao, liga ou modalidade indisponivel', async () => {
    const where = prisma.competicaoLiga.findFirst.mock.calls;
    await service.buscarCompeticao(1);
    expect(where[0][0].where).toMatchObject({ id: 1, visivelApp: true,
      ligaModalidade: { ativa: true, modalidade: { ativa: true }, liga: { status: 'ATIVA', visivelApp: true } } });
    prisma.competicaoLiga.findFirst.mockResolvedValue(null);
    await expect(service.buscarCompeticao(2)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.inscricaoTimeCompeticao.count).toHaveBeenCalledTimes(1);
  });

  it('mapeia premiacao existente sem expor colunas internas', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(row({ premiacoes: [{ posicaoInicio: 1, posicaoFim: 1, tipoPremiacao: 'VALOR_FIXO', valor: new Prisma.Decimal(10), percentual: null, ordem: 1 }] }));
    expect((await service.buscarCompeticao(1)).premiacao).toEqual([{ posicaoInicio: 1, posicaoFim: 1, tipoPremiacao: 'VALOR_FIXO', valor: 10, percentual: null, ordem: 1 }]);
  });

  it('controllers permanecem publicos, sem JwtAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LigasController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, CompeticoesController)).toBeUndefined();
  });
});
