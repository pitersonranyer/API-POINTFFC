import { BadRequestException, Injectable } from '@nestjs/common';
import { CartolaService } from '../cartola/cartola.service';
import { PartialScoreService } from '../partial-score/partial-score.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeSnapshotsService } from '../time-snapshots/time-snapshots.service';
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
    private readonly cartola: CartolaService,
    private readonly partialScore: PartialScoreService,
    private readonly timeSnapshots: TimeSnapshotsService,
  ) {}

  async atualizarRodadaAnterior(temporadaInformada?: number): Promise<AtualizarRodadaAnteriorResponseDto> {
    const status = (await this.cartola.getMarketStatus()).value;
    const rodada = status.rodada_atual - 1;
    if (rodada < 1) throw new BadRequestException('Ainda nao existe rodada anterior nesta temporada');

    const temporada = status.temporada ?? temporadaInformada;
    if (!Number.isInteger(temporada) || (temporada as number) < 1) {
      throw new BadRequestException('Informe a temporada, pois o Cartola nao a retornou no status do mercado');
    }

    const cadastrados = await this.prisma.timeUsuario.findMany({
      select: { timeId: true },
      distinct: ['timeId'],
      orderBy: { timeId: 'asc' },
    });
    const timeIds = cadastrados.map(({ timeId }) => timeId);
    const snapshotsExistentes = await this.prisma.timeRodada.findMany({
      where: { temporada: temporada as number, rodada, timeId: { in: timeIds } },
      select: { id: true, timeId: true },
    });
    const comSnapshot = new Set(snapshotsExistentes.map(({ timeId }) => timeId));
    const ausentes = timeIds.filter((timeId) => !comSnapshot.has(timeId));
    const snapshotsCriados: Array<{ id: number; timeId: number }> = [];
    const timeIdsSemSnapshot: number[] = [];
    let nextSnapshotIndex = 0;
    const snapshotWorker = async (): Promise<void> => {
      while (nextSnapshotIndex < ausentes.length) {
        const timeId = ausentes[nextSnapshotIndex++];
        try {
          const criado = await this.timeSnapshots.criarSnapshot({
            timeId,
            temporada: temporada as number,
            rodada,
          });
          snapshotsCriados.push({ id: criado.timeRodadaId, timeId });
        } catch {
          timeIdsSemSnapshot.push(timeId);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(10, ausentes.length) }, () => snapshotWorker()));
    timeIdsSemSnapshot.sort((a, b) => a - b);
    const snapshots = [...snapshotsExistentes, ...snapshotsCriados];
    const pontuacoesExistentes = await this.prisma.pontuacaoTimeRodada.findMany({
      where: { timeRodadaId: { in: snapshots.map(({ id }) => id) } },
      select: { timeRodadaId: true },
    });
    const idsProcessados = new Set(pontuacoesExistentes.map(({ timeRodadaId }) => timeRodadaId));
    const pendentes = snapshots.filter(({ id }) => !idsProcessados.has(id));
    const detalhesFalhas: Array<{ timeId: number; motivo: string }> = [];
    let atualizados = 0;
    let nextIndex = 0;
    const concorrencia = Math.min(10, pendentes.length);

    const worker = async (): Promise<void> => {
      while (nextIndex < pendentes.length) {
        const { timeId } = pendentes[nextIndex++];
        try {
          await this.partialScore.calcular({ timeId, temporada: temporada as number, rodada });
          atualizados += 1;
        } catch (error) {
          detalhesFalhas.push({
            timeId,
            motivo: error instanceof Error ? error.message : 'Erro desconhecido ao calcular a parcial',
          });
        }
      }
    };

    await Promise.all(Array.from({ length: concorrencia }, () => worker()));
    detalhesFalhas.sort((a, b) => a.timeId - b.timeId);

    return {
      temporada: temporada as number,
      rodada,
      timesCadastrados: timeIds.length,
      atualizados,
      jaProcessados: idsProcessados.size,
      semSnapshot: timeIdsSemSnapshot.length,
      timeIdsSemSnapshot,
      falhas: detalhesFalhas.length,
      detalhesFalhas,
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
