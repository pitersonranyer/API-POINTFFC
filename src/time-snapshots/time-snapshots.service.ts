import { BadGatewayException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../cartola/cartola.service';
import { CartolaSnapshotAthlete, CartolaTimeIdentity, CartolaTimeSnapshotPayload } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';

export interface CriarSnapshotTimeInput {
  timeId: number;
  temporada: number;
  rodada: number;
}

export interface SnapshotTimeResultado {
  timeId: number;
  temporada: number;
  rodada: number;
  timeRodadaId: string;
  criado: boolean;
  titulares: number;
  reservas: number;
}

interface SnapshotNormalizado {
  time: {
    timeId: number;
    nomeTime: string;
    nomeCartoleiro: string | null;
    slug: string | null;
    escudoUrl: string | null;
    fotoPerfilUrl: string | null;
    assinante: boolean | null;
  };
  esquemaTatico: number | null;
  patrimonio: Prisma.Decimal | null;
  capitaoId: number | null;
  reservaLuxoId: number | null;
  titulares: AtletaNormalizado[];
  reservas: AtletaNormalizado[];
}

interface AtletaNormalizado {
  atletaId: number;
  posicaoId: number;
  clubeId: number | null;
}

@Injectable()
export class TimeSnapshotsService {
  constructor(
    private readonly cartola: CartolaService,
    private readonly prisma: PrismaService,
  ) {}

  async criarSnapshot(input: CriarSnapshotTimeInput): Promise<SnapshotTimeResultado> {
    this.validarInput(input);
    const response = await this.cartola.getTeamById(input.timeId, { forceRefresh: true });
    const snapshot = this.normalizarPayload(input.timeId, response.value);

    try {
      return await this.persistirSnapshot(input, snapshot);
    } catch (error) {
      if (!this.isSnapshotConcurrencyConflict(error)) throw error;
      const existente = await this.buscarSnapshotExistente(input);
      if (!existente) throw error;
      return this.toResultadoExistente(input, existente);
    }
  }

  private persistirSnapshot(input: CriarSnapshotTimeInput, snapshot: SnapshotNormalizado): Promise<SnapshotTimeResultado> {
    return this.prisma.$transaction(async (tx) => {
        await tx.timeCartola.upsert({
          where: { timeId: input.timeId },
          create: snapshot.time,
          update: {
            nomeTime: snapshot.time.nomeTime,
            nomeCartoleiro: snapshot.time.nomeCartoleiro,
            slug: snapshot.time.slug,
            escudoUrl: snapshot.time.escudoUrl,
            fotoPerfilUrl: snapshot.time.fotoPerfilUrl,
            assinante: snapshot.time.assinante,
          },
        });

        const existente = await tx.timeRodada.findUnique({
          where: { timeId_temporada_rodada: input },
          include: { escalacao: true },
        });
        if (existente) return this.toResultadoExistente(input, existente);

        const timeRodada = await tx.timeRodada.create({
          data: {
            timeId: input.timeId,
            temporada: input.temporada,
            rodada: input.rodada,
            esquemaTatico: snapshot.esquemaTatico,
            patrimonio: snapshot.patrimonio,
            capitaoId: snapshot.capitaoId,
            reservaLuxoId: snapshot.reservaLuxoId,
            status: 'CAPTURADO',
          },
        });
        const escalacao = [
          ...snapshot.titulares.map((atleta) => this.toEscalacao(atleta, timeRodada.id, true, snapshot.capitaoId)),
          ...snapshot.reservas.map((atleta) => this.toEscalacao(atleta, timeRodada.id, false, snapshot.capitaoId)),
        ];
        await tx.escalacaoTimeRodada.createMany({ data: escalacao });

        return {
          timeId: input.timeId,
          temporada: input.temporada,
          rodada: input.rodada,
          timeRodadaId: timeRodada.id,
          criado: true,
          titulares: snapshot.titulares.length,
          reservas: snapshot.reservas.length,
        };
      });
  }

  private buscarSnapshotExistente(input: CriarSnapshotTimeInput) {
    return this.prisma.timeRodada.findUnique({
      where: { timeId_temporada_rodada: input },
      include: { escalacao: true },
    });
  }

  private toResultadoExistente(
    input: CriarSnapshotTimeInput,
    existente: { id: string; escalacao: Array<{ titular: boolean; reserva: boolean }> },
  ): SnapshotTimeResultado {
    return {
      timeId: input.timeId,
      temporada: input.temporada,
      rodada: input.rodada,
      timeRodadaId: existente.id,
      criado: false,
      titulares: existente.escalacao.filter((atleta) => atleta.titular).length,
      reservas: existente.escalacao.filter((atleta) => atleta.reserva).length,
    };
  }

  private isSnapshotConcurrencyConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
    const target = error.meta?.target;
    if (error.meta?.modelName === 'TimeCartola' && target === 'PRIMARY') return true;
    if (typeof target === 'string') {
      return target.toUpperCase() === 'TIME_RODADA_TIME_ID_TEMPORADA_RODADA_KEY';
    }
    if (!Array.isArray(target)) return false;
    const fields = new Set(target.map((field) => String(field).toLowerCase()));
    const camelCase = ['timeid', 'temporada', 'rodada'].every((field) => fields.has(field));
    const databaseNames = ['time_id', 'temporada', 'rodada'].every((field) => fields.has(field));
    return fields.size === 3 && (camelCase || databaseNames);
  }

  private validarInput(input: CriarSnapshotTimeInput): void {
    if (!Number.isInteger(input.timeId) || input.timeId < 1) throw new BadGatewayException('timeId inválido para captura do snapshot');
    if (!Number.isInteger(input.temporada) || input.temporada < 1) throw new BadGatewayException('temporada inválida para captura do snapshot');
    if (!Number.isInteger(input.rodada) || input.rodada < 1 || input.rodada > 38) throw new BadGatewayException('rodada inválida para captura do snapshot');
  }

  private normalizarPayload(timeIdSolicitado: number, payload: CartolaTimeSnapshotPayload): SnapshotNormalizado {
    if (!this.isRecord(payload)) throw this.payloadInvalido();
    const identity = this.isRecord(payload.time) ? payload.time as CartolaTimeIdentity : payload;
    const payloadTimeId = this.optionalPositiveInteger(identity.time_id, 'time.time_id');
    if (payloadTimeId !== null && payloadTimeId !== timeIdSolicitado) throw this.payloadInvalido('time_id divergente do solicitado');

    const nomeTime = this.requiredString(identity.nome, 'time.nome');
    const titulares = this.normalizeAthletes(payload.atletas, 'atletas', true);
    if (titulares.length === 0) throw this.payloadInvalido('atletas deve conter ao menos um titular válido');
    const reservas = this.normalizeAthletes(payload.reservas, 'reservas', false);
    const capitaoId = this.optionalPositiveInteger(payload.capitao_id, 'capitao_id');
    const reservaLuxoId = this.optionalPositiveInteger(payload.reserva_luxo_id, 'reserva_luxo_id');
    const atletaIds = [...titulares, ...reservas].map((atleta) => atleta.atletaId);
    if (new Set(atletaIds).size !== atletaIds.length) throw this.payloadInvalido('atleta duplicado na escalação');
    if (capitaoId !== null && !atletaIds.includes(capitaoId)) throw this.payloadInvalido('capitão não pertence à escalação');
    if (reservaLuxoId !== null && !reservas.some((atleta) => atleta.atletaId === reservaLuxoId)) {
      throw this.payloadInvalido('Reserva de Luxo não pertence às reservas');
    }

    return {
      time: {
        timeId: timeIdSolicitado,
        nomeTime,
        nomeCartoleiro: this.optionalString(identity.nome_cartola ?? identity.cartoleiro_nome, 'time.nome_cartola'),
        slug: this.optionalString(identity.slug, 'time.slug'),
        escudoUrl: this.optionalString(identity.url_escudo_png ?? identity.url_escudo_svg, 'time.url_escudo_png'),
        fotoPerfilUrl: this.optionalString(identity.foto_perfil, 'time.foto_perfil'),
        assinante: this.optionalBoolean(identity.assinante, 'time.assinante'),
      },
      esquemaTatico: this.optionalPositiveInteger(payload.esquema_id, 'esquema_id'),
      patrimonio: this.optionalDecimal(payload.patrimonio, 'patrimonio'),
      capitaoId,
      reservaLuxoId,
      titulares,
      reservas,
    };
  }

  private normalizeAthletes(value: unknown, field: string, required: boolean): AtletaNormalizado[] {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value)) throw this.payloadInvalido(`${field} deve ser uma lista`);
    return value.map((item, index) => {
      if (!this.isRecord(item)) throw this.payloadInvalido(`${field}[${index}] inválido`);
      const athlete = item as CartolaSnapshotAthlete;
      return {
        atletaId: this.requiredPositiveInteger(athlete.atleta_id, `${field}[${index}].atleta_id`),
        posicaoId: this.requiredPositiveInteger(athlete.posicao_id, `${field}[${index}].posicao_id`),
        clubeId: this.optionalPositiveInteger(athlete.clube_id, `${field}[${index}].clube_id`),
      };
    });
  }

  private toEscalacao(atleta: AtletaNormalizado, timeRodadaId: string, titular: boolean, capitaoId: number | null) {
    return {
      timeRodadaId,
      atletaId: atleta.atletaId,
      posicaoId: atleta.posicaoId,
      clubeId: atleta.clubeId,
      titular,
      reserva: !titular,
      capitao: atleta.atletaId === capitaoId,
    };
  }

  private requiredPositiveInteger(value: unknown, field: string): number {
    const normalized = this.optionalPositiveInteger(value, field);
    if (normalized === null) throw this.payloadInvalido(`${field} ausente`);
    return normalized;
  }

  private optionalPositiveInteger(value: unknown, field: string): number | null {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || (value as number) < 1) throw this.payloadInvalido(`${field} inválido`);
    return value as number;
  }

  private requiredString(value: unknown, field: string): string {
    const normalized = this.optionalString(value, field);
    if (normalized === null) throw this.payloadInvalido(`${field} ausente`);
    return normalized;
  }

  private optionalString(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim().length === 0) throw this.payloadInvalido(`${field} inválido`);
    return value.trim();
  }

  private optionalBoolean(value: unknown, field: string): boolean | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'boolean') throw this.payloadInvalido(`${field} inválido`);
    return value;
  }

  private optionalDecimal(value: unknown, field: string): Prisma.Decimal | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw this.payloadInvalido(`${field} inválido`);
    return new Prisma.Decimal(value);
  }

  private payloadInvalido(detail?: string): BadGatewayException {
    return new BadGatewayException(`Payload de time inválido recebido do Cartola${detail ? `: ${detail}` : ''}`);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
