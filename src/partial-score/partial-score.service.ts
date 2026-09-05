import { BadGatewayException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaScoredAthlete, CartolaScoredAthletesPayload, CartolaScouts } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveLineup } from '../round-processing/round-calculator';

export interface CalcularParcialInput {
  timeId: number;
  temporada: number;
  rodada: number;
}

export type StatusPontuacaoAtleta = 'PONTUADO' | 'SEM_PONTUACAO';

export interface DetalhePontuacaoAtleta {
  atletaId: number;
  posicaoId: number;
  clubeId: number | null;
  capitao: boolean;
  pontuacaoOriginal: number;
  multiplicador: 1 | 1.5;
  pontuacaoContabilizada: number;
  scouts: CartolaScouts | null;
  possuiPontuacao: boolean;
  entrouEmCampo: boolean | null;
  status: StatusPontuacaoAtleta;
}

export interface ParcialTimeResultado {
  timeId: number;
  temporada: number;
  rodada: number;
  timeRodadaId: number;
  pontuacaoParcial: number;
  status: 'PARCIAL' | 'FINAL';
  atletas: DetalhePontuacaoAtleta[];
}

interface PontuadoNormalizado {
  pontuacao: Prisma.Decimal;
  scouts: CartolaScouts | null;
  entrouEmCampo: boolean | null;
}

@Injectable()
export class PartialScoreService {
  private readonly logger = new Logger(PartialScoreService.name);

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async calcular(input: CalcularParcialInput): Promise<ParcialTimeResultado> {
    const [timeRodada, round] = await this.prisma.$transaction([this.prisma.timeRodada.findUnique({
      where: { timeId_temporada_rodada: input },
      include: { escalacao: true, pontuacao: true, substituicoes: { where: { ativa: true } } },
    }), this.prisma.rodadaProcessamento.findUnique({
      where: { temporada_rodada: { temporada: input.temporada, rodada: input.rodada } },
    })], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (!timeRodada) throw new NotFoundException('Snapshot do time não encontrado para temporada e rodada');

    const titularesOriginais = timeRodada.escalacao.filter((atleta) => atleta.titular);
    this.validarEscalacao(titularesOriginais, timeRodada.capitaoId);
    const titulares = effectiveLineup(timeRodada, timeRodada.substituicoes);

    if (!round?.pontuados || !timeRodada.pontuacao) {
      throw new UnprocessableEntityException('Rodada aguardando processamento pelo scheduler');
    }
    const pontuados = this.normalizarPontuados(round.pontuados as CartolaScoredAthletesPayload, input.rodada);
    const detalhes = titulares.map((atleta) => {
      const pontuado = pontuados.get(atleta.atletaId);
      const original = pontuado?.pontuacao ?? new Prisma.Decimal(0);
      const contabilizada = atleta.capitao ? original.mul('1.5') : original;
      return {
        atletaId: atleta.atletaId,
        posicaoId: atleta.posicaoId,
        clubeId: atleta.clubeId,
        capitao: atleta.capitao,
        pontuacaoOriginal: original.toNumber(),
        multiplicador: atleta.capitao ? 1.5 as const : 1 as const,
        pontuacaoContabilizada: this.arredondar(contabilizada).toNumber(),
        scouts: pontuado?.scouts ?? null,
        possuiPontuacao: pontuado !== undefined,
        entrouEmCampo: pontuado?.entrouEmCampo ?? null,
        status: pontuado ? 'PONTUADO' as const : 'SEM_PONTUACAO' as const,
      };
    });
    const totalExato = titulares.reduce((total, atleta) => {
      const original = pontuados.get(atleta.atletaId)?.pontuacao ?? new Prisma.Decimal(0);
      return total.plus(atleta.capitao ? original.mul('1.5') : original);
    }, new Prisma.Decimal(0));
    const total = this.arredondar(totalExato);



    return {
      timeId: input.timeId,
      temporada: input.temporada,
      rodada: input.rodada,
      timeRodadaId: timeRodada.id,
      pontuacaoParcial: total.toNumber(),
      status: timeRodada.pontuacao.status,
      atletas: detalhes,
    };
  }

  private validarEscalacao(titulares: Array<{ atletaId: number; capitao: boolean }>, capitaoId: number | null): void {
    if (titulares.length === 0) throw new UnprocessableEntityException('Snapshot sem atletas titulares');
    if (new Set(titulares.map((atleta) => atleta.atletaId)).size !== titulares.length) {
      throw new UnprocessableEntityException('Snapshot com atletas titulares duplicados');
    }
    const capitaes = titulares.filter((atleta) => atleta.capitao);
    if (capitaes.length > 1) {
      throw new UnprocessableEntityException('Snapshot com mais de um capitão');
    }
    if ((capitaoId === null && capitaes.length > 0) || (capitaoId !== null && (capitaes.length !== 1 || capitaes[0].atletaId !== capitaoId))) {
      throw new UnprocessableEntityException('Snapshot com identificação de capitão inconsistente');
    }
  }

  private normalizarPontuados(payload: CartolaScoredAthletesPayload, rodadaEsperada: number): Map<number, PontuadoNormalizado> {
    if (!this.isRecord(payload) || !this.isRecord(payload.atletas)) throw this.payloadInvalido('atletas deve ser um objeto');
    if (!Number.isInteger(payload.rodada) || (payload.rodada as number) < 1 || payload.rodada !== rodadaEsperada) {
      throw this.payloadInvalido('rodada divergente da solicitada');
    }

    const pontuados = new Map<number, PontuadoNormalizado>();
    for (const [rawAtletaId, value] of Object.entries(payload.atletas)) {
      try {
        const [atletaId, pontuado] = this.normalizarEntradaPontuada(rawAtletaId, value);
        pontuados.set(atletaId, pontuado);
      } catch (error) {
        this.logger.warn({
          event: 'cartola_scored_athlete_ignored',
          atletaId: rawAtletaId,
          reason: error instanceof Error ? error.message : 'entrada inválida',
        });
      }
    }
    return pontuados;
  }

  private normalizarEntradaPontuada(rawAtletaId: string, value: unknown): [number, PontuadoNormalizado] {
    const atletaId = Number(rawAtletaId);
    if (!Number.isInteger(atletaId) || atletaId < 1 || !this.isRecord(value)) throw new Error('entrada de atleta inválida');
    const athlete = value as CartolaScoredAthlete;
    if (typeof athlete.pontuacao !== 'number' || !Number.isFinite(athlete.pontuacao)) throw new Error('pontuação inválida');
    this.validarCampoOpcionalInteiro(athlete.posicao_id, 'posicao_id');
    this.validarCampoOpcionalInteiro(athlete.clube_id, 'clube_id');
    if (athlete.entrou_em_campo !== undefined && typeof athlete.entrou_em_campo !== 'boolean') throw new Error('entrou_em_campo inválido');
    return [atletaId, {
      pontuacao: new Prisma.Decimal(athlete.pontuacao.toString()),
      scouts: this.normalizarScouts(athlete.scout, atletaId),
      entrouEmCampo: athlete.entrou_em_campo ?? null,
    }];
  }

  private normalizarScouts(value: unknown, atletaId: number): CartolaScouts | null {
    if (value === undefined || value === null) return null;
    if (!this.isRecord(value)) throw this.payloadInvalido(`scout inválido para atleta ${atletaId}`);
    const scouts: CartolaScouts = {};
    for (const [code, quantity] of Object.entries(value)) {
      if (typeof quantity !== 'number' || !Number.isFinite(quantity)) throw this.payloadInvalido(`scout ${code} inválido para atleta ${atletaId}`);
      scouts[code] = quantity;
    }
    return scouts;
  }

  private validarCampoOpcionalInteiro(value: unknown, field: string): void {
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) throw new Error(`${field} inválido`);
  }

  private arredondar(value: Prisma.Decimal): Prisma.Decimal {
    return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private payloadInvalido(detail: string): BadGatewayException {
    return new BadGatewayException(`Payload de atletas pontuados inválido: ${detail}`);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
