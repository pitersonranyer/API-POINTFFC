import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { mapMinha, minhaSelect, motivoBloqueioInscricao } from './inscricoes-competicao.service';
import { ResumoCompeticaoResponseDto } from './dto/resumo-competicao.dto';

@Injectable()
export class ResumoCompeticaoService {
  constructor(private readonly prisma: PrismaService) {}

  async consultar(id: number, usuarioId?: number): Promise<ResumoCompeticaoResponseDto> {
    const row = await this.prisma.competicaoLiga.findFirst({
      where: { id, visivelApp: true },
      select: {
        id: true, nome: true, slug: true, descricao: true, tipoAcesso: true, valorInscricao: true,
        rodadaInicio: true, rodadaFim: true, inicioInscricao: true, fimInscricao: true,
        dataInicio: true, dataFim: true, limiteTimesUsuario: true, limiteParticipantes: true,
        status: true, destaque: true, visivelApp: true,
        ligaModalidade: { select: {
          ativa: true,
          liga: { select: { id: true, nome: true, slug: true, imagemUrl: true, status: true, visivelApp: true } },
          modalidade: { select: { codigo: true, nome: true, ativa: true } },
        } },
        premiacoes: { orderBy: [{ ordem: 'asc' }, { id: 'asc' }], select: {
          posicaoInicio: true, posicaoFim: true, tipoPremiacao: true,
          valor: true, percentual: true, ordem: true,
        } },
      },
    });
    if (!row) throw new NotFoundException('Competicao nao encontrada.');

    const minhasQuery = usuarioId === undefined ? null : this.prisma.inscricaoTimeCompeticao.findMany({
      where: { competicaoLigaId: id, usuarioId },
      select: minhaSelect,
      orderBy: [{ dataInscricao: 'asc' }, { id: 'asc' }],
    });
    const [quantidade, minhasRows] = await Promise.all([
      this.prisma.inscricaoTimeCompeticao.count({ where: { competicaoLigaId: id, statusInscricao: 'ATIVA' } }),
      minhasQuery,
    ]);

    const { ligaModalidade, premiacoes, visivelApp, valorInscricao, inicioInscricao, fimInscricao, dataInicio, dataFim, ...dados } = row;
    const { status: ligaStatus, visivelApp: ligaVisivelApp, ...liga } = ligaModalidade.liga;
    const { ativa: modalidadeAtiva, ...modalidade } = ligaModalidade.modalidade;
    const resposta: ResumoCompeticaoResponseDto = {
      competicao: {
        ...dados,
        valorInscricao: valorInscricao.toNumber(),
        inicioInscricao: inicioInscricao?.toISOString() ?? null,
        fimInscricao: fimInscricao?.toISOString() ?? null,
        dataInicio: dataInicio?.toISOString() ?? null,
        dataFim: dataFim?.toISOString() ?? null,
      },
      liga,
      modalidade,
      inscritos: { quantidade },
      premiacao: premiacoes.map(premio => ({ ...premio,
        valor: premio.valor?.toNumber() ?? null,
        percentual: premio.percentual?.toNumber() ?? null,
      })),
    };

    if (usuarioId !== undefined && minhasRows !== null) {
      const minhasInscricoes = minhasRows.map(rowMinha => {
        const { valorInscricao: _snapshot, ...fields } = mapMinha(rowMinha);
        void _snapshot;
        return fields;
      });
      const quantidadeTimesInscritos = minhasRows.filter(inscricao => inscricao.statusInscricao === 'ATIVA').length;
      const ativas = minhasRows.filter(inscricao => inscricao.statusInscricao === 'ATIVA');
      const posicoes = ativas.map(inscricao => inscricao.posicao).filter((posicao): posicao is number => posicao !== null);
      const pontuacoes = ativas.map(inscricao => inscricao.pontuacao).filter((pontuacao): pontuacao is NonNullable<typeof pontuacao> => pontuacao !== null);
      const melhorPosicaoUsuario = posicoes.length ? Math.min(...posicoes) : null;
      const melhorPontuacaoUsuario = pontuacoes.length
        ? pontuacoes.reduce((melhor, pontuacao) => pontuacao.gt(melhor) ? pontuacao : melhor).toNumber() : null;
      const motivoBloqueio = motivoBloqueioInscricao({
        visivelApp,
        tipoAcesso: row.tipoAcesso,
        valorInscricao,
        status: row.status,
        inicioInscricao,
        fimInscricao,
        limiteTimesUsuario: row.limiteTimesUsuario,
        limiteParticipantes: row.limiteParticipantes,
        ligaModalidade: { ativa: ligaModalidade.ativa,
          liga: { status: ligaStatus, visivelApp: ligaVisivelApp }, modalidade: { ativa: modalidadeAtiva } },
      }, new Date(), { participantes: quantidade, timesUsuario: quantidadeTimesInscritos });
      resposta.usuario = { quantidadeTimesInscritos, limiteTimesUsuario: row.limiteTimesUsuario,
        podeInscrever: motivoBloqueio === null, motivoBloqueio, melhorPosicaoUsuario, melhorPontuacaoUsuario };
      resposta.minhasInscricoes = minhasInscricoes;
    }
    return resposta;
  }
}
