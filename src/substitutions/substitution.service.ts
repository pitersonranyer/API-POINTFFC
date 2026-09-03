import { BadGatewayException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../cartola/cartola.service';
import { CartolaScoredAthlete, CartolaScoredAthletesPayload, CartolaTeamSubstitutionsPayload } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';
import { ScoredAthletesCacheService } from '../scored-athletes-cache/scored-athletes-cache.service';

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
    private readonly cartola: CartolaService,
    private readonly scoredAthletesCache: ScoredAthletesCacheService,
  ) {}

  async processar(input: ProcessarSubstituicoesInput): Promise<SubstitutionResult> {
    this.validarInput(input);
    const timeRodada = await this.prisma.timeRodada.findUnique({
      where: { timeId_temporada_rodada: input },
      include: { escalacao: true },
    });
    if (!timeRodada) throw new NotFoundException('Snapshot do time não encontrado para temporada e rodada');

    const oficiais = this.normalizarSubstituicoes(await this.cartola.getTeamSubstitutions(input.timeId));
    this.validarContraSnapshot(oficiais, timeRodada.escalacao);
    const scoredResponse = await this.scoredAthletesCache.getScoredAthletes(input.temporada, input.rodada);
    const pontuados = this.normalizarPontuados(scoredResponse.value, input.rodada);

    const titulares = timeRodada.escalacao.filter((atleta) => atleta.titular);
    const pontuacaoBase = this.calcularTotal(titulares, pontuados);
    const efetivos = this.montarEscalacaoEfetiva(timeRodada.escalacao, oficiais);
    const pontuacaoEfetiva = this.calcularTotal(efetivos, pontuados);
    const detalhes = oficiais.map((substituicao) => {
      const saiu = pontuados.get(substituicao.atletaSaiuId) ?? new Prisma.Decimal(0);
      const entrou = pontuados.get(substituicao.atletaEntrouId) ?? new Prisma.Decimal(0);
      return {
        saiu: { atletaId: substituicao.atletaSaiuId, pontuacao: this.arredondar(saiu).toNumber() },
        entrou: { atletaId: substituicao.atletaEntrouId, pontuacao: this.arredondar(entrou).toNumber() },
        posicaoId: substituicao.posicaoId,
        delta: this.arredondar(entrou.minus(saiu)).toNumber(),
        reservaLuxo: timeRodada.reservaLuxoId === substituicao.atletaEntrouId,
      };
    });

    await this.persistir(timeRodada.id, oficiais, pontuacaoEfetiva);
    return {
      ...input,
      pontuacaoBase: pontuacaoBase.toNumber(),
      pontuacaoEfetiva: pontuacaoEfetiva.toNumber(),
      reservaLuxoId: timeRodada.reservaLuxoId,
      substituicoes: detalhes,
    };
  }

  private persistir(timeRodadaId: number, substituicoes: SubstituicaoNormalizada[], total: Prisma.Decimal): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.substituicaoTimeRodada.deleteMany({
        where: substituicoes.length === 0
          ? { timeRodadaId }
          : {
              timeRodadaId,
              NOT: {
                OR: substituicoes.map((item) => ({
                  atletaSaiuId: item.atletaSaiuId,
                  atletaEntrouId: item.atletaEntrouId,
                })),
              },
            },
      });
      if (substituicoes.length > 0) {
        await tx.substituicaoTimeRodada.createMany({
          data: substituicoes.map((item) => ({ timeRodadaId, ...item })),
          skipDuplicates: true,
        });
      }
      await tx.pontuacaoTimeRodada.upsert({
        where: { timeRodadaId },
        create: { timeRodadaId, pontuacao: total, status: 'PARCIAL' },
        update: { pontuacao: total, status: 'PARCIAL' },
      });
    });
  }

  private montarEscalacaoEfetiva(escalacao: AtletaEscalacao[], substituicoes: SubstituicaoNormalizada[]): AtletaEscalacao[] {
    const efetivos = new Map(escalacao.filter((atleta) => atleta.titular).map((atleta) => [atleta.atletaId, atleta]));
    const reservas = new Map(escalacao.filter((atleta) => atleta.reserva).map((atleta) => [atleta.atletaId, atleta]));
    for (const substituicao of substituicoes) {
      efetivos.delete(substituicao.atletaSaiuId);
      const reserva = reservas.get(substituicao.atletaEntrouId)!;
      efetivos.set(reserva.atletaId, { ...reserva, titular: true, reserva: false, capitao: false });
    }
    return [...efetivos.values()];
  }

  private calcularTotal(atletas: AtletaEscalacao[], pontuados: Map<number, Prisma.Decimal>): Prisma.Decimal {
    const total = atletas.reduce((sum, atleta) => {
      const pontos = pontuados.get(atleta.atletaId) ?? new Prisma.Decimal(0);
      return sum.plus(atleta.capitao ? pontos.mul('1.5') : pontos);
    }, new Prisma.Decimal(0));
    return this.arredondar(total);
  }

  private normalizarSubstituicoes(payload: CartolaTeamSubstitutionsPayload): SubstituicaoNormalizada[] {
    if (!Array.isArray(payload)) throw this.payloadInvalido('raiz deve ser uma lista');
    const normalized = payload.map((item, index) => {
      if (!this.isRecord(item) || !this.isRecord(item.saiu) || !this.isRecord(item.entrou)) {
        throw this.payloadInvalido(`substituição ${index} inválida`);
      }
      const posicaoId = this.positiveInteger(item.posicao_id, `substituição ${index}.posicao_id`);
      const atletaSaiuId = this.positiveInteger(item.saiu.atleta_id, `substituição ${index}.saiu.atleta_id`);
      const atletaEntrouId = this.positiveInteger(item.entrou.atleta_id, `substituição ${index}.entrou.atleta_id`);
      const posicaoSaiu = this.positiveInteger(item.saiu.posicao_id, `substituição ${index}.saiu.posicao_id`);
      const posicaoEntrou = this.positiveInteger(item.entrou.posicao_id, `substituição ${index}.entrou.posicao_id`);
      if (posicaoId !== posicaoSaiu || posicaoId !== posicaoEntrou) {
        throw this.payloadInvalido(`posição divergente na substituição ${index}`);
      }
      if (atletaSaiuId === atletaEntrouId) throw this.payloadInvalido(`atletas iguais na substituição ${index}`);
      return { atletaSaiuId, atletaEntrouId, posicaoId };
    });
    const pairs = normalized.map((item) => `${item.atletaSaiuId}:${item.atletaEntrouId}`);
    if (new Set(pairs).size !== pairs.length) throw this.payloadInvalido('substituição duplicada');
    if (new Set(normalized.map((item) => item.atletaSaiuId)).size !== normalized.length) {
      throw this.payloadInvalido('um titular aparece em mais de uma substituição');
    }
    if (new Set(normalized.map((item) => item.atletaEntrouId)).size !== normalized.length) {
      throw this.payloadInvalido('uma reserva aparece em mais de uma substituição');
    }
    return normalized;
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

  private positiveInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value) || (value as number) < 1) throw this.payloadInvalido(`${field} inválido`);
    return value as number;
  }

  private arredondar(value: Prisma.Decimal): Prisma.Decimal {
    return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private payloadInvalido(detail: string): BadGatewayException {
    return new BadGatewayException(`Payload de substituições inválido: ${detail}`);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
