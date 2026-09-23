import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ResumoCompeticaoService } from '../src/ligas-competicoes/resumo-competicao.service';
import { PrismaService } from '../src/prisma/prisma.service';

const agora = new Date('2026-09-14T12:00:00Z');
const inscricao = (statusInscricao = 'ATIVA') => ({
  id: 8, timeIdCartola: 123, nomeTime: 'Snapshot', nomeCartoleiro: 'Cartoleiro', escudoUrl: null,
  statusInscricao, pontuacao: null, posicao: null, posicaoAnterior: null, premioApurado: null,
  dataInscricao: new Date('2026-09-10T00:00:00Z'), valorInscricao: new Prisma.Decimal(0),
});
const competicao = (changes: Record<string, unknown> = {}) => ({
  id: 1, nome: 'POINT FFC - Rodada 27', slug: 'point-ffc-rodada-27', descricao: null,
  tipoAcesso: 'FREE', valorInscricao: new Prisma.Decimal(0), rodadaInicio: 27, rodadaFim: 27,
  inicioInscricao: new Date('2026-09-01T00:00:00Z'), fimInscricao: new Date('2026-09-30T23:59:59Z'),
  dataInicio: new Date('2026-10-01T00:00:00Z'), dataFim: new Date('2026-10-07T23:59:59Z'),
  limiteTimesUsuario: 30, limiteParticipantes: null, status: 'INSCRICOES_ABERTAS', destaque: true, visivelApp: true,
  ligaModalidade: { ativa: true,
    liga: { id: 2, nome: 'POINT FFC', slug: 'point-ffc', imagemUrl: null, status: 'ATIVA' },
    modalidade: { codigo: 'RODADA', nome: 'Rodada', ativa: true } },
  premiacoes: [], ...changes,
});

describe('ResumoCompeticaoService', () => {
  const prisma = { competicaoLiga: { findFirst: jest.fn() }, inscricaoTimeCompeticao: { count: jest.fn(), findMany: jest.fn() } };
  const service = new ResumoCompeticaoService(prisma as unknown as PrismaService);
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(agora);
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao());
    prisma.inscricaoTimeCompeticao.count.mockResolvedValue(0);
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([]);
  });
  afterEach(() => jest.useRealTimers());

  it('retorna resumo publico sem consultar nem expor dados pessoais', async () => {
    const resposta = await service.consultar(1);
    expect(resposta).toMatchObject({
      competicao: { id: 1, nome: 'POINT FFC - Rodada 27', tipoAcesso: 'FREE', valorInscricao: 0 },
      liga: { id: 2, slug: 'point-ffc' }, modalidade: { codigo: 'RODADA' },
      inscritos: { quantidade: 0 }, premiacao: [],
    });
    expect(resposta).not.toHaveProperty('usuario');
    expect(resposta).not.toHaveProperty('minhasInscricoes');
    expect(prisma.inscricaoTimeCompeticao.findMany).not.toHaveBeenCalled();
    expect(prisma.competicaoLiga.findFirst.mock.calls[0][0].where).toEqual({ id: 1, visivelApp: true });
  });

  it('retorna 404 para competicao inexistente ou invisivel', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(null);
    await expect(service.consultar(1)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.inscricaoTimeCompeticao.count).not.toHaveBeenCalled();
  });

  it('conta apenas inscritos ATIVA', async () => {
    prisma.inscricaoTimeCompeticao.count.mockResolvedValue(7);
    expect((await service.consultar(1)).inscritos.quantidade).toBe(7);
    expect(prisma.inscricaoTimeCompeticao.count).toHaveBeenCalledWith({ where: { competicaoLigaId: 1, statusInscricao: 'ATIVA' } });
  });

  it('retorna resumo autenticado com minhas inscricoes e podeInscrever true', async () => {
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([inscricao(), inscricao('CANCELADA')]);
    const resposta = await service.consultar(1, 10);
    expect(resposta.usuario).toEqual({ quantidadeTimesInscritos: 1, limiteTimesUsuario: 30, podeInscrever: true,
      motivoBloqueio: null, melhorPosicaoUsuario: null, melhorPontuacaoUsuario: null });
    expect(resposta.minhasInscricoes).toHaveLength(2);
    expect(resposta.minhasInscricoes?.[0]).toMatchObject({ id: 8, timeIdCartola: 123, nomeTime: 'Snapshot' });
    expect(resposta.minhasInscricoes?.[0]).not.toHaveProperty('valorInscricao');
    expect(prisma.inscricaoTimeCompeticao.findMany.mock.calls[0][0]).toMatchObject({ where: { competicaoLigaId: 1, usuarioId: 10 },
      orderBy: [{ dataInscricao: 'asc' }, { id: 'asc' }] });
  });

  it('nao inclui inscricoes de outro usuario', async () => {
    await service.consultar(1, 99);
    expect(prisma.inscricaoTimeCompeticao.findMany.mock.calls[0][0].where.usuarioId).toBe(99);
  });

  it('calcula melhor posicao e melhor pontuacao apenas entre inscricoes ativas', async () => {
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([
      { ...inscricao(), id: 1, posicao: 5, pontuacao: new Prisma.Decimal('12.50') },
      { ...inscricao(), id: 2, posicao: 2, pontuacao: new Prisma.Decimal('10.25') },
      { ...inscricao('CANCELADA'), id: 3, posicao: 1, pontuacao: new Prisma.Decimal('99.00') },
    ]);
    expect((await service.consultar(1, 10)).usuario).toMatchObject({
      melhorPosicaoUsuario: 2, melhorPontuacaoUsuario: 12.5,
    });
  });

  it('retorna null para melhores marcas sem inscricao ativa', async () => {
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([{ ...inscricao('CANCELADA'), posicao: 1,
      pontuacao: new Prisma.Decimal('99.00') }]);
    expect((await service.consultar(1, 10)).usuario).toMatchObject({
      melhorPosicaoUsuario: null, melhorPontuacaoUsuario: null,
    });
  });

  it('bloqueia por status de inscricoes', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao({ status: 'INSCRICOES_ENCERRADAS' }));
    expect((await service.consultar(1, 10)).usuario).toMatchObject({ podeInscrever: false, motivoBloqueio: 'INSCRICOES_FECHADAS' });
  });

  it.each([
    ['antes', { inicioInscricao: new Date('2026-09-15T00:00:00Z') }],
    ['depois', { fimInscricao: new Date('2026-09-13T23:59:59Z') }],
  ])('bloqueia fora da janela: %s', async (_label, change) => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao(change));
    expect((await service.consultar(1, 10)).usuario?.motivoBloqueio).toBe('FORA_JANELA_INSCRICAO');
  });

  it('bloqueia pelo limite de times ativos do usuario', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao({ limiteTimesUsuario: 1 }));
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([inscricao()]);
    expect((await service.consultar(1, 10)).usuario).toMatchObject({ podeInscrever: false, motivoBloqueio: 'LIMITE_TIMES_USUARIO_ATINGIDO' });
  });

  it('bloqueia pelo limite total de participantes', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao({ limiteParticipantes: 1 }));
    prisma.inscricaoTimeCompeticao.count.mockResolvedValue(1);
    expect((await service.consultar(1, 10)).usuario?.motivoBloqueio).toBe('LIMITE_PARTICIPANTES_ATINGIDO');
  });

  it('permite competicao paga com preco valido', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao({ tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal('10') }));
    expect((await service.consultar(1, 10)).usuario).toMatchObject({ podeInscrever: true, motivoBloqueio: null });
  });

  it('bloqueia competicao paga com preco invalido', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao({ tipoAcesso: 'PAGO' }));
    expect((await service.consultar(1, 10)).usuario?.motivoBloqueio).toBe('COMPETICAO_INDISPONIVEL');
  });

  it.each([
    ['liga', { ativa: true, liga: { id: 2, nome: 'POINT FFC', slug: 'point-ffc', imagemUrl: null, status: 'INATIVA' }, modalidade: { codigo: 'RODADA', nome: 'Rodada', ativa: true } }],
    ['vinculo', { ativa: false, liga: { id: 2, nome: 'POINT FFC', slug: 'point-ffc', imagemUrl: null, status: 'ATIVA' }, modalidade: { codigo: 'RODADA', nome: 'Rodada', ativa: true } }],
    ['modalidade', { ativa: true, liga: { id: 2, nome: 'POINT FFC', slug: 'point-ffc', imagemUrl: null, status: 'ATIVA' }, modalidade: { codigo: 'RODADA', nome: 'Rodada', ativa: false } }],
  ])('indica competicao indisponivel quando %s inativa', async (_label, ligaModalidade) => {
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao({ ligaModalidade }));
    expect((await service.consultar(1, 10)).usuario?.motivoBloqueio).toBe('COMPETICAO_INDISPONIVEL');
  });

  it('mapeia premiacao cadastrada e mantem array vazio quando ausente', async () => {
    expect((await service.consultar(1)).premiacao).toEqual([]);
    prisma.competicaoLiga.findFirst.mockResolvedValue(competicao({ premiacoes: [{ posicaoInicio: 1, posicaoFim: 1,
      tipoPremiacao: 'VALOR_FIXO', valor: new Prisma.Decimal(10), percentual: null, ordem: 1 }] }));
    expect((await service.consultar(1)).premiacao).toEqual([{ posicaoInicio: 1, posicaoFim: 1, tipoPremiacao: 'VALOR_FIXO', valor: 10, percentual: null, ordem: 1 }]);
  });
});
