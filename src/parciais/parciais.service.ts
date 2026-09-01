import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ListaParciaisResponseDto, ParcialTimeResponseDto } from './dto/parcial-time-response.dto';

export interface ListarParciaisInput {
  temporada: number;
  rodada: number;
  timeIds: number[];
}

@Injectable()
export class ParciaisService {
  constructor(private readonly prisma: PrismaService) {}

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
