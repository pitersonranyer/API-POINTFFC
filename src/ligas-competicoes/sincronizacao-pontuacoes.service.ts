import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DiagnosticoEscalacoesService } from './diagnostico-escalacoes.service';
import { RankingCompeticaoService, AtualizacaoPontuacaoInscricao } from './ranking-competicao.service';

export type MotivoPendenciaPontuacao = 'TIME_RODADA_NAO_ENCONTRADO' | 'PONTUACAO_INDISPONIVEL';

export interface ResultadoSincronizacaoPontuacoes {
  competicaoId: number;
  rodada: number;
  quantidadeInscricoesAtivas: number;
  quantidadeAtualizadas: number;
  quantidadePendentes: number;
  pendencias: Array<{ inscricaoId: number; timeIdCartola: number; nomeTime: string; motivo: MotivoPendenciaPontuacao }>;
}

@Injectable()
export class SincronizacaoPontuacoesService {
  private readonly logger = new Logger(SincronizacaoPontuacoesService.name);
  constructor(private readonly prisma: PrismaService, private readonly diagnostico: DiagnosticoEscalacoesService,
    private readonly ranking: RankingCompeticaoService) {}

  async sincronizarRodada(temporada: number, rodada: number): Promise<void> {
    const inicioTemporada = new Date(Date.UTC(temporada, 0, 1));
    const fimTemporada = new Date(Date.UTC(temporada + 1, 0, 1));
    const competicoes = await this.prisma.competicaoLiga.findMany({
      where: { rodadaInicio: rodada, rodadaFim: rodada,
        dataInicio: { gte: inicioTemporada, lt: fimTemporada },
        visivelApp: true, status: { in: ['INSCRICOES_ABERTAS', 'INSCRICOES_ENCERRADAS', 'EM_ANDAMENTO', 'ENCERRADA'] },
        ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: true }, modalidade: { ativa: true } },
        inscricoes: { some: { statusInscricao: 'ATIVA' } },
      },
      select: { id: true }, orderBy: { id: 'asc' },
    });
    for (const competicaoId of new Set(competicoes.map(competicao => competicao.id))) {
      try {
        const resultado = await this.sincronizarPontuacoesCompeticao(competicaoId);
        this.logger.log({ competicaoId, temporada, rodada,
          quantidadeAtualizadas: resultado.quantidadeAtualizadas,
          quantidadePendentes: resultado.quantidadePendentes });
      } catch (error) {
        this.logger.error({ competicaoId, temporada, rodada,
          erro: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async sincronizarPontuacoesCompeticao(competicaoId: number): Promise<ResultadoSincronizacaoPontuacoes> {
    const { rodada, temporada } = await this.diagnostico.obterContextoRodadaUnica(competicaoId);
    const inscricoes = await this.prisma.inscricaoTimeCompeticao.findMany({
      where: { competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' },
      select: { id: true, timeIdCartola: true, nomeTime: true }, orderBy: { id: 'asc' },
    });
    const times = inscricoes.length ? await this.prisma.timeRodada.findMany({
      where: { temporada, rodada, timeId: { in: inscricoes.map(inscricao => inscricao.timeIdCartola) } },
      select: { timeId: true, pontuacao: { select: { pontuacao: true } } },
    }) : [];
    const porTime = new Map(times.map(time => [time.timeId, time]));
    const atualizacoes: AtualizacaoPontuacaoInscricao[] = [];
    const pendencias: ResultadoSincronizacaoPontuacoes['pendencias'] = [];
    for (const inscricao of inscricoes) {
      const time = porTime.get(inscricao.timeIdCartola);
      if (!time || !time.pontuacao) {
        pendencias.push({ inscricaoId: inscricao.id, timeIdCartola: inscricao.timeIdCartola,
          nomeTime: inscricao.nomeTime,
          motivo: time ? 'PONTUACAO_INDISPONIVEL' : 'TIME_RODADA_NAO_ENCONTRADO' });
      } else {
        atualizacoes.push({ inscricaoId: inscricao.id, pontuacao: time.pontuacao.pontuacao });
      }
    }
    // Reutiliza a transacao e o desempate do ranking; as pendencias mantem sua pontuacao anterior, se houver.
    if (atualizacoes.length) await this.ranking.atualizarPontuacoes(competicaoId, atualizacoes);
    return { competicaoId, rodada, quantidadeInscricoesAtivas: inscricoes.length,
      quantidadeAtualizadas: atualizacoes.length, quantidadePendentes: pendencias.length, pendencias };
  }
}
