import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { RoundProcessingService } from '../round-processing/round-processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { AtualizarRodadaAnteriorResponseDto } from './dto/atualizar-rodada-anterior.dto';
import { ListaParciaisResponseDto, ParcialTimeResponseDto } from './dto/parcial-time-response.dto';

export interface ListarParciaisInput {
  temporada: number;
  rodada: number;
  timeIds: number[];
}

@Injectable()
export class ParciaisService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly rounds?: RoundProcessingService,
  ) {}

  async atualizarRodadaAnterior(temporadaInformada?: number): Promise<AtualizarRodadaAnteriorResponseDto> {
    if (!this.rounds) throw new BadRequestException('Processador de rodadas indisponivel');
    const processed = await this.rounds.reconcilePending(temporadaInformada);
    const round = await this.prisma.rodadaProcessamento.findFirst({
      where: { ...(temporadaInformada === undefined ? {} : { temporada: temporadaInformada }) },
      orderBy: [{ temporada: 'desc' }, { rodada: 'desc' }],
    });
    if (!round) throw new BadRequestException('Nenhuma rodada capturada para conciliacao');
    const expected = round.timesPrevistos as number[];
    const snapshots = await this.prisma.timeRodada.findMany({
      where: { temporada: round.temporada, rodada: round.rodada },
      select: { timeId: true, pontuacao: { select: { status: true } } },
    });
    const ids = new Set(snapshots.map((t) => t.timeId));
    const missing = expected.filter((id) => !ids.has(id));
    const completed = snapshots.filter((t) => t.pontuacao?.status === 'FINAL').length;
    const updated = processed.some((r) => r.temporada === round.temporada && r.rodada === round.rodada);
    return {
      temporada: round.temporada, rodada: round.rodada, timesCadastrados: expected.length,
      atualizados: updated ? completed : 0, jaProcessados: updated ? 0 : completed, semSnapshot: missing.length,
      timeIdsSemSnapshot: missing, falhas: 0, detalhesFalhas: [],
    };
  }

  async listar(input: ListarParciaisInput): Promise<ListaParciaisResponseDto> {
    const times = await this.prisma.timeCartola.findMany({
      where: { timeId: { in: input.timeIds } },
      select: {
        timeId: true,
        nomeTime: true,
        nomeCartoleiro: true,
        escudoUrl: true,
        rodadas: {
          where: { temporada: input.temporada, rodada: input.rodada },
          take: 1,
          select: {
            pontuacao: {
              select: { pontuacao: true, status: true, atualizadoEm: true },
            },
          },
        },
      },
    });

    const byId = new Map(times.map((time) => [time.timeId, time]));
    const parciais = input.timeIds.map<ParcialTimeResponseDto>((timeId) => {
      const time = byId.get(timeId);
      if (!time) {
        return {
          timeId,
          nomeTime: null,
          nomeCartoleiro: null,
          escudoUrl: null,
          pontuacao: null,
          status: 'NAO_ENCONTRADO',
          atualizadoEm: null,
        };
      }

      const pontuacao = time.rodadas[0]?.pontuacao;
      return {
        timeId,
        nomeTime: time.nomeTime,
        nomeCartoleiro: time.nomeCartoleiro,
        escudoUrl: time.escudoUrl,
        pontuacao: pontuacao?.pontuacao.toNumber() ?? null,
        status: pontuacao?.status ?? 'AGUARDANDO',
        atualizadoEm: pontuacao?.atualizadoEm ?? null,
      };
    });

    return { temporada: input.temporada, rodada: input.rodada, parciais };
  }
}
