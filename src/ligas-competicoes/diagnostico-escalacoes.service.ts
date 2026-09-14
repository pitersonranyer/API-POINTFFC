import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AssociacaoEscalacao {
  inscricaoId: number;
  timeIdCartola: number;
  nomeTime: string;
  rodada: number;
  escalacaoEncontrada: boolean;
  timeRodadaId: number | null;
}

export interface DiagnosticoEscalacoes {
  competicaoId: number;
  rodada: number;
  quantidadeInscricoesAtivas: number;
  quantidadeEscalacoesEncontradas: number;
  quantidadeEscalacoesPendentes: number;
  pendencias: Array<{ inscricaoId: number; timeIdCartola: number; nomeTime: string }>;
}

@Injectable()
export class DiagnosticoEscalacoesService {
  constructor(private readonly prisma: PrismaService) {}

  async obterContextoRodadaUnica(competicaoId: number): Promise<{ rodada: number; temporada: number }> {
    const competicao = await this.prisma.competicaoLiga.findUnique({
      where: { id: competicaoId },
      select: { id: true, rodadaInicio: true, rodadaFim: true, dataInicio: true },
    });
    if (!competicao) throw new NotFoundException('Competicao nao encontrada.');
    if (competicao.rodadaInicio === null || competicao.rodadaInicio !== competicao.rodadaFim || competicao.dataInicio === null) {
      throw new BadRequestException('Diagnostico exige competicao de rodada unica com DATA_INICIO para identificar a temporada.');
    }
    return { rodada: competicao.rodadaInicio, temporada: competicao.dataInicio.getUTCFullYear() };
  }

  async associar(competicaoId: number): Promise<{ competicaoId: number; rodada: number; temporada: number; inscricoes: AssociacaoEscalacao[] }> {
    const { rodada, temporada } = await this.obterContextoRodadaUnica(competicaoId);

    const inscricoes = await this.prisma.inscricaoTimeCompeticao.findMany({
      where: { competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' },
      select: { id: true, timeIdCartola: true, nomeTime: true },
      orderBy: { id: 'asc' },
    });
    if (!inscricoes.length) return { competicaoId, rodada, temporada, inscricoes: [] };

    const snapshots = await this.prisma.timeRodada.findMany({
      where: { temporada, rodada, timeId: { in: inscricoes.map(inscricao => inscricao.timeIdCartola) },
        escalacao: { some: { titular: true } } },
      select: { id: true, timeId: true },
    });
    const porTime = new Map(snapshots.map(snapshot => [snapshot.timeId, snapshot.id]));
    return { competicaoId, rodada, temporada, inscricoes: inscricoes.map(inscricao => ({
      inscricaoId: inscricao.id, timeIdCartola: inscricao.timeIdCartola, nomeTime: inscricao.nomeTime,
      rodada, escalacaoEncontrada: porTime.has(inscricao.timeIdCartola),
      timeRodadaId: porTime.get(inscricao.timeIdCartola) ?? null,
    })) };
  }

  async diagnosticar(competicaoId: number): Promise<DiagnosticoEscalacoes> {
    const associacao = await this.associar(competicaoId);
    const pendencias = associacao.inscricoes.filter(inscricao => !inscricao.escalacaoEncontrada)
      .map(({ inscricaoId, timeIdCartola, nomeTime }) => ({ inscricaoId, timeIdCartola, nomeTime }));
    return {
      competicaoId, rodada: associacao.rodada,
      quantidadeInscricoesAtivas: associacao.inscricoes.length,
      quantidadeEscalacoesEncontradas: associacao.inscricoes.length - pendencias.length,
      quantidadeEscalacoesPendentes: pendencias.length,
      pendencias,
    };
  }
}
