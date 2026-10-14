import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const REQUEST_TTL_MS = 10 * 60 * 1000;
const REQUEST_LIMIT = 3;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const CONFIRM_LIMIT = 10;
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const MAX_RATE_LIMIT_KEYS = 5000;

interface WindowCounter { timestamps: number[] }
export interface TelegramLinkStatus { linked: boolean; linkedAt?: string }

@Injectable()
export class TelegramLinkService {
  private readonly requestLimits = new Map<string, WindowCounter>();
  private readonly confirmLimits = new Map<number, WindowCounter>();

  constructor(private readonly prisma: PrismaService) {}

  async createRequest(telegramUserId: string): Promise<{ code: string; expiresAt: Date }> {
    this.enforceLimit(this.requestLimits, telegramUserId, REQUEST_LIMIT, REQUEST_WINDOW_MS);
    await this.prisma.telegramLinkRequest.deleteMany({ where: { expiraEm: { lt: new Date() } } });
    const code = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
    await this.prisma.telegramLinkRequest.create({
      data: { telegramUserId, codigoHash: this.hash(code), expiraEm: expiresAt },
    });
    return { code, expiresAt };
  }

  async confirm(usuarioId: number, code: string): Promise<TelegramLinkStatus> {
    this.enforceLimit(this.confirmLimits, usuarioId, CONFIRM_LIMIT, CONFIRM_WINDOW_MS);
    const codigoHash = this.hash(code);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.telegramLinkRequest.findUnique({ where: { codigoHash } });
        const now = new Date();
        if (!request || request.usadoEm || request.expiraEm <= now) {
          throw new BadRequestException('Solicitação de vínculo inválida ou expirada.');
        }

        const existing = await tx.telegramAccountLink.findFirst({
          where: { OR: [{ usuarioId }, { telegramUserId: request.telegramUserId }] },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException('Vínculo conflitante. Desconecte o vínculo atual antes de tentar novamente.');
        }

        const consumed = await tx.telegramLinkRequest.updateMany({
          where: { id: request.id, usadoEm: null, expiraEm: { gt: now } },
          data: { usadoEm: now },
        });
        if (consumed.count !== 1) {
          throw new BadRequestException('Solicitação de vínculo inválida ou expirada.');
        }

        const link = await tx.telegramAccountLink.create({
          data: { usuarioId, telegramUserId: request.telegramUserId },
          select: { criadoEm: true },
        });
        return { linked: true, linkedAt: link.criadoEm.toISOString() };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Vínculo conflitante. Desconecte o vínculo atual antes de tentar novamente.');
      }
      throw error;
    }
  }

  async status(usuarioId: number): Promise<TelegramLinkStatus> {
    const link = await this.prisma.telegramAccountLink.findUnique({
      where: { usuarioId },
      select: { criadoEm: true },
    });
    return link ? { linked: true, linkedAt: link.criadoEm.toISOString() } : { linked: false };
  }

  async disconnect(usuarioId: number): Promise<TelegramLinkStatus> {
    await this.prisma.telegramAccountLink.deleteMany({ where: { usuarioId } });
    return { linked: false };
  }

  private hash(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
  }

  private enforceLimit<K extends string | number>(
    limits: Map<K, WindowCounter>,
    key: K,
    maximum: number,
    windowMs: number,
  ): void {
    const now = Date.now();
    const validAfter = now - windowMs;
    const counter = limits.get(key) ?? { timestamps: [] };
    counter.timestamps = counter.timestamps.filter((timestamp) => timestamp > validAfter);
    if (counter.timestamps.length >= maximum) {
      throw new HttpException('Limite de solicitações atingido. Tente novamente mais tarde.', HttpStatus.TOO_MANY_REQUESTS);
    }
    counter.timestamps.push(now);
    limits.set(key, counter);

    if (limits.size > MAX_RATE_LIMIT_KEYS) {
      for (const [candidate, value] of limits) {
        value.timestamps = value.timestamps.filter((timestamp) => timestamp > validAfter);
        if (value.timestamps.length === 0) limits.delete(candidate);
        if (limits.size <= MAX_RATE_LIMIT_KEYS) break;
      }
    }
  }
}
