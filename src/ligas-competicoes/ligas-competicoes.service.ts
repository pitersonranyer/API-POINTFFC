import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListarCompeticoesQueryDto } from './dto/ligas-competicoes-query.dto';
import { CompeticaoDetalheDto, CompeticaoResumoDto, LigaResponseDto } from './dto/ligas-competicoes-response.dto';

const publicLiga = { status: 'ATIVA', visivelApp: true } as const;
const publicModalidade = { ativa: true, modalidade: { ativa: true } } as const;
const competicaoSelect = {
  id: true, nome: true, slug: true, descricao: true, tipoAcesso: true, valorInscricao: true,
  rodadaInicio: true, rodadaFim: true, inicioInscricao: true, fimInscricao: true,
  dataInicio: true, dataFim: true, limiteTimesUsuario: true, limiteParticipantes: true,
  status: true, destaque: true,
  ligaModalidade: { select: { modalidade: { select: { codigo: true, nome: true } } } },
} satisfies Prisma.CompeticaoLigaSelect;
type CompeticaoRow = Prisma.CompeticaoLigaGetPayload<{ select: typeof competicaoSelect }>;

function resumo(row: CompeticaoRow): CompeticaoResumoDto {
  const { ligaModalidade, valorInscricao, inicioInscricao, fimInscricao, dataInicio, dataFim, ...fields } = row;
  return {
    ...fields,
    valorInscricao: valorInscricao.toNumber(),
    inicioInscricao: inicioInscricao?.toISOString() ?? null,
    fimInscricao: fimInscricao?.toISOString() ?? null,
    dataInicio: dataInicio?.toISOString() ?? null,
    dataFim: dataFim?.toISOString() ?? null,
    modalidade: ligaModalidade.modalidade,
  };
}

@Injectable()
export class LigasCompeticoesService {
  private readonly logger = new Logger(LigasCompeticoesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async buscarLiga(slug: string): Promise<LigaResponseDto> {
    const liga = await this.prisma.liga.findFirst({
      where: { slug, ...publicLiga },
      select: {
        id: true, nome: true, slug: true, descricao: true, imagemUrl: true, tipo: true,
        modalidades: {
          where: publicModalidade,
          orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
          select: { modalidade: { select: { codigo: true, nome: true } } },
        },
      },
    });
    if (!liga) throw new NotFoundException('Liga nao encontrada.');
    const { modalidades, ...fields } = liga;
    return { ...fields, modalidades: modalidades.map(vinculo => vinculo.modalidade) };
  }

  async listarCompeticoes(slug: string, query: ListarCompeticoesQueryDto): Promise<CompeticaoResumoDto[]> {
    this.logger.log(`listarCompeticoes entrada ${JSON.stringify({ slug, modalidade: query.modalidade ?? null,
      rodada: query.rodada ?? null, status: query.status ?? null })}`);
    const liga = await this.prisma.liga.findFirst({ where: { slug, ...publicLiga }, select: { id: true } });
    if (!liga) throw new NotFoundException('Liga nao encontrada.');
    this.logger.log(`listarCompeticoes liga ${JSON.stringify({ ligaId: liga.id })}`);

    const where: Prisma.CompeticaoLigaWhereInput = {
      visivelApp: true,
      ligaModalidade: {
        ligaId: liga.id,
        ...publicModalidade,
        ...(query.modalidade ? { modalidade: { ativa: true, codigo: query.modalidade } } : {}),
      },
      ...(query.rodada !== undefined ? { rodadaInicio: { lte: query.rodada }, rodadaFim: { gte: query.rodada } } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    this.logger.log(`listarCompeticoes where ${JSON.stringify(where)}`);
    try {
      const visiveis = await this.prisma.competicaoLiga.findMany({
        where: { visivelApp: true }, select: { id: true, slug: true, ligaModalidadeId: true },
      });
      this.logger.log(`listarCompeticoes diagnosticoVisiveis ${JSON.stringify(visiveis)}`);
    } catch (error) {
      this.logger.warn(`listarCompeticoes diagnosticoVisiveis falhou: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rows = await this.prisma.competicaoLiga.findMany({
      where, select: competicaoSelect,
      orderBy: [{ destaque: 'desc' }, { valorInscricao: 'asc' }, { nome: 'asc' }, { id: 'asc' }],
    });
    this.logger.log(`listarCompeticoes resultado ${JSON.stringify({ quantidade: rows.length,
      competicoes: rows.map(({ id, slug }) => ({ id, slug })) })}`);
    return rows.map(resumo);
  }

  async buscarCompeticao(id: number): Promise<CompeticaoDetalheDto> {
    const row = await this.prisma.competicaoLiga.findFirst({
      where: {
        id, visivelApp: true,
        ligaModalidade: { ...publicModalidade, liga: publicLiga },
      },
      select: {
        ...competicaoSelect,
        ligaModalidade: { select: {
          modalidade: { select: { codigo: true, nome: true } },
          liga: { select: { id: true, nome: true, slug: true, imagemUrl: true } },
        } },
        premiacoes: { orderBy: [{ ordem: 'asc' }, { id: 'asc' }], select: {
          posicaoInicio: true, posicaoFim: true, tipoPremiacao: true,
          valor: true, percentual: true, ordem: true,
        } },
      },
    });
    if (!row) throw new NotFoundException('Competicao nao encontrada.');
    const quantidadeInscritos = await this.prisma.inscricaoTimeCompeticao.count({
      where: { competicaoLigaId: id, statusInscricao: 'ATIVA' },
    });
    const { premiacoes, ligaModalidade, ...fields } = row;
    return {
      ...resumo({ ...fields, ligaModalidade }),
      liga: ligaModalidade.liga,
      quantidadeInscritos,
      premiacao: premiacoes.map(premio => ({
        ...premio,
        valor: premio.valor?.toNumber() ?? null,
        percentual: premio.percentual?.toNumber() ?? null,
      })),
    };
  }
}
