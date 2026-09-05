import { BadGatewayException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaScoredAthlete, CartolaScoredAthletesPayload } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveLineup } from '../round-processing/round-calculator';

export interface ProcessarSubstituicoesInput {
  timeId: number;
  temporada: number;
  rodada: number;
}

interface SubstituicaoNormalizada {
  atletaSaiuId: number;
  atletaEntrouId: number;
  posicaoId: number;
}

interface AtletaEscalacao {
  atletaId: number;
  posicaoId: number;
  titular: boolean;
  reserva: boolean;
  capitao: boolean;
}

export interface SubstituicaoDetalhada {
  saiu: { atletaId: number; pontuacao: number };
  entrou: { atletaId: number; pontuacao: number };
  posicaoId: number;
  delta: number;
  reservaLuxo: boolean;
}

export interface SubstitutionResult {
  timeId: number;
  temporada: number;
  rodada: number;
  pontuacaoBase: number;
  pontuacaoEfetiva: number;
  reservaLuxoId: number | null;
  substituicoes: SubstituicaoDetalhada[];
}

@Injectable()
export class SubstitutionService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async processar(input: ProcessarSubstituicoesInput): Promise<SubstitutionResult> {
    this.validarInput(input);
    const [timeRodada, round] = await this.prisma.$transaction([this.prisma.timeRodada.findUnique({
      where: { timeId_temporada_rodada: input },
      include: { escalacao: true, substituicoes: { where: { ativa: true } } },
    }), this.prisma.rodadaProcessamento.findUnique({
      where: { temporada_rodada: { temporada: input.temporada, rodada: input.rodada } },
    })], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (!timeRodada) throw new NotFoundException('Snapshot do time não encontrado para temporada e rodada');

    const oficiais = timeRodada.substituicoes;
    this.validarContraSnapshot(oficiais, timeRodada.escalacao);
    if (!round?.pontuados) throw new UnprocessableEntityException('Rodada aguardando processamento pelo scheduler');
    const pontuados = this.normalizarPontuados(round.pontuados as CartolaScoredAthletesPayload, input.rodada);

    const titulares = timeRodada.escalacao.filter((atleta) => atleta.titular);
    const pontuacaoBase = this.calcularTotal(titulares, pontuados);
    const efetivos = effectiveLineup(timeRodada, oficiais);
    const pontuacaoEfetiva = this.calcularTotal(efetivos, pontuados);
    const detalhes = oficiais.map((substituicao) => {
      const saiu = pontuados.get(substituicao.atletaSaiuId) ?? new Prisma.Decimal(0);
      const entrou = pontuados.get(substituicao.atletaEntrouId) ?? new Prisma.Decimal(0);
      const multiplier = titulares.find((a) => a.atletaId === substituicao.atletaSaiuId)?.capitao ? '1.5' : '1';
      return {
        saiu: { atletaId: substituicao.atletaSaiuId, pontuacao: this.arredondar(saiu).toNumber() },
        entrou: { atletaId: substituicao.atletaEntrouId, pontuacao: this.arredondar(entrou).toNumber() },
        posicaoId: substituicao.posicaoId,
        delta: this.arredondar(entrou.minus(saiu).mul(multiplier)).toNumber(),
        reservaLuxo: timeRodada.reservaLuxoId === substituicao.atletaEntrouId,
      };
    });

    return {
      ...input,
      pontuacaoBase: pontuacaoBase.toNumber(),
      pontuacaoEfetiva: pontuacaoEfetiva.toNumber(),
      reservaLuxoId: timeRodada.reservaLuxoId,
      substituicoes: detalhes,
    };
  }

  private calcularTotal(atletas: AtletaEscalacao[], pontuados: Map<number, Prisma.Decimal>): Prisma.Decimal {
    const total = atletas.reduce((sum, atleta) => {
      const pontos = pontuados.get(atleta.atletaId) ?? new Prisma.Decimal(0);
      return sum.plus(atleta.capitao ? pontos.mul('1.5') : pontos);
    }, new Prisma.Decimal(0));
    return this.arredondar(total);
  }

  private validarContraSnapshot(substituicoes: SubstituicaoNormalizada[], escalacao: AtletaEscalacao[]): void {
    const titulares = new Map(escalacao.filter((atleta) => atleta.titular).map((atleta) => [atleta.atletaId, atleta]));
    const reservas = new Map(escalacao.filter((atleta) => atleta.reserva).map((atleta) => [atleta.atletaId, atleta]));
    for (const substituicao of substituicoes) {
      const saiu = titulares.get(substituicao.atletaSaiuId);
      const entrou = reservas.get(substituicao.atletaEntrouId);
      if (!saiu) throw new UnprocessableEntityException(`Atleta que saiu não pertence aos titulares originais: ${substituicao.atletaSaiuId}`);
      if (!entrou) throw new UnprocessableEntityException(`Atleta que entrou não pertence às reservas originais: ${substituicao.atletaEntrouId}`);
      if (saiu.posicaoId !== substituicao.posicaoId || entrou.posicaoId !== substituicao.posicaoId) {
        throw new UnprocessableEntityException('Posição da substituição diverge do snapshot original');
      }
    }
  }

  private normalizarPontuados(payload: CartolaScoredAthletesPayload, rodada: number): Map<number, Prisma.Decimal> {
    if (!this.isRecord(payload) || !this.isRecord(payload.atletas) || payload.rodada !== rodada) {
      throw new BadGatewayException('Payload de atletas pontuados inválido para a rodada');
    }
    const result = new Map<number, Prisma.Decimal>();
    for (const [rawId, rawAthlete] of Object.entries(payload.atletas)) {
      const id = Number(rawId);
      const athlete = rawAthlete as CartolaScoredAthlete;
      if (!Number.isInteger(id) || id < 1 || !this.isRecord(rawAthlete)) continue;
      if (typeof athlete.pontuacao !== 'number' || !Number.isFinite(athlete.pontuacao)) continue;
      result.set(id, new Prisma.Decimal(athlete.pontuacao.toString()));
    }
    return result;
  }

  private validarInput(input: ProcessarSubstituicoesInput): void {
    if (!Number.isInteger(input.timeId) || input.timeId < 1) throw new BadGatewayException('timeId inválido');
    if (!Number.isInteger(input.temporada) || input.temporada < 1) throw new BadGatewayException('temporada inválida');
    if (!Number.isInteger(input.rodada) || input.rodada < 1 || input.rodada > 38) throw new BadGatewayException('rodada inválida');
  }

  private arredondar(value: Prisma.Decimal): Prisma.Decimal {
    return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
