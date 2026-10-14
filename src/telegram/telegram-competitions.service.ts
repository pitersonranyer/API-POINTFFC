import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CompeticaoCardDto } from '../ligas-competicoes/dto/ligas-competicoes-response.dto';
import { ListarCompeticoesQueryDto } from '../ligas-competicoes/dto/ligas-competicoes-query.dto';
import { LigasCompeticoesService } from '../ligas-competicoes/ligas-competicoes.service';
import { motivoBloqueioInscricao } from '../ligas-competicoes/inscricoes-competicao.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TelegramCompetitionsService {
  constructor(
    private readonly ligasCompeticoesService: LigasCompeticoesService,
    private readonly prisma: PrismaService,
  ) {}

  async listarDivulgaveis(now = new Date()): Promise<CompeticaoCardDto[]> {
    const query: ListarCompeticoesQueryDto = { status: 'INSCRICOES_ABERTAS' };
    const competicoes = await this.ligasCompeticoesService.listarCompeticoes('point-ffc', query);
    if (competicoes.length === 0) return [];

    const inscricoesAtivas = await this.prisma.inscricaoTimeCompeticao.groupBy({
      by: ['competicaoLigaId'],
      where: {
        competicaoLigaId: { in: competicoes.map(competicao => competicao.id) },
        statusInscricao: 'ATIVA',
      },
      _count: { _all: true },
    });
    const participantesPorCompeticao = new Map(
      inscricoesAtivas.map(item => [item.competicaoLigaId, item._count._all]),
    );

    return competicoes.filter(competicao => motivoBloqueioInscricao({
      visivelApp: true,
      tipoAcesso: competicao.tipoAcesso,
      valorInscricao: new Prisma.Decimal(competicao.valorInscricao),
      status: competicao.status,
      inicioInscricao: competicao.inicioInscricao ? new Date(competicao.inicioInscricao) : null,
      fimInscricao: competicao.fimInscricao ? new Date(competicao.fimInscricao) : null,
      // The Telegram listing has no individual user context, so only global limits apply here.
      limiteTimesUsuario: null,
      limiteParticipantes: competicao.limiteParticipantes,
      ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: true }, modalidade: { ativa: true } },
    }, now, {
      participantes: participantesPorCompeticao.get(competicao.id) ?? 0,
      timesUsuario: 0,
    }) === null);
  }
}
