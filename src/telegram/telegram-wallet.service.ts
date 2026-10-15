import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, TelegramWalletRequest } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CarteiraService } from '../carteira/carteira.service';
import { RecargaPixService } from '../carteira/recarga-pix.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const ACTIVE_PAYMENT_STATUSES = ['PENDENTE', 'PROCESSANDO'] as const;

export interface TelegramWalletPayment {
  id: number;
  valor: string;
  status: string;
  idPagamentoExterno: string | null;
  pixCopiaCola: string | null;
  qrCode: string | null;
  expiracao: Date | null;
}

export interface TelegramWalletOperationView {
  id: string;
  usuarioId: number;
  valor: string;
  confirmado: boolean;
  expiraEm: Date;
  recarga: TelegramWalletPayment | null;
}

export interface TelegramWalletSnapshot {
  usuarioId: number;
  saldoDisponivel: string;
  saldoBloqueado: string;
  status: string;
  operation: TelegramWalletOperationView | null;
}

@Injectable()
export class TelegramWalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: TelegramLinkService,
    private readonly carteiras: CarteiraService,
    private readonly recargasPix: RecargaPixService,
  ) {}

  validarValor(valor: string): void {
    this.recargasPix.validarValor(valor);
  }

  async consultar(telegramUserId: string): Promise<TelegramWalletSnapshot> {
    const usuario = await this.resolveUser(telegramUserId);
    const carteira = await this.carteiras.obterOuCriar(usuario.idUsuario);
    const request = await this.findActiveRequest(telegramUserId, usuario.idUsuario);
    return {
      usuarioId: usuario.idUsuario,
      saldoDisponivel: carteira.saldoDisponivel.toFixed(2),
      saldoBloqueado: carteira.saldoBloqueado.toFixed(2),
      status: carteira.status,
      operation: request ? this.view(request) : null,
    };
  }

  async preparar(telegramUserId: string, valor: string): Promise<TelegramWalletOperationView> {
    this.validarValor(valor);
    const usuario = await this.resolveUser(telegramUserId);
    return this.prisma.$transaction(async (tx) => {
      // Acquire the user lock before any consistent read establishes a
      // REPEATABLE READ snapshot, so a waiting request sees the last commit.
      await tx.$queryRaw<{ id_usuario: number | bigint }[]>`
        SELECT id_usuario FROM USUARIO WHERE id_usuario = ${usuario.idUsuario} FOR UPDATE`;
      await this.assertActiveLink(tx, telegramUserId, usuario.idUsuario);
      const active = await this.findActiveRequest(telegramUserId, usuario.idUsuario, tx);
      if (active) return this.view(active);

      const request = await tx.telegramWalletRequest.create({
        data: {
          id: randomUUID(),
          telegramUserId,
          usuarioId: usuario.idUsuario,
          idempotencyKey: randomUUID(),
          valor: new Prisma.Decimal(valor),
          expiraEm: new Date(Date.now() + CONFIRMATION_TTL_MS),
        },
        include: { recarga: true },
      });
      return this.view(request);
    });
  }

  async confirmar(telegramUserId: string, operationId: string): Promise<TelegramWalletPayment> {
    const usuario = await this.resolveUser(telegramUserId);
    const request = await this.confirmRequest(telegramUserId, usuario.idUsuario, operationId);
    const result = await this.recargasPix.criarParaTelegram(
      usuario,
      request.valor.toFixed(2),
      request.idempotencyKey,
    );
    await this.linkRecarga(request.id, usuario.idUsuario, telegramUserId, result.id);
    return this.payment(result);
  }

  async atualizar(telegramUserId: string, operationId: string): Promise<TelegramWalletPayment> {
    const usuario = await this.resolveUser(telegramUserId);
    const request = await this.findOwnedRequest(telegramUserId, usuario.idUsuario, operationId);
    if (!request.confirmadoEm) {
      throw new ConflictException('A geração desta cobrança ainda não foi confirmada.');
    }

    let result: Awaited<ReturnType<RecargaPixService['criar']>>;
    if (request.recargaId !== null) {
      result = await this.recargasPix.consultarStatusTelegram(usuario.idUsuario, request.recargaId);
    } else {
      // A mesma chave persistida recupera a recarga após timeout ou reinício.
      result = await this.recargasPix.criarParaTelegram(usuario, request.valor.toFixed(2), request.idempotencyKey);
    }
    await this.linkRecarga(request.id, usuario.idUsuario, telegramUserId, result.id);
    return this.payment(result);
  }

  async abandonar(telegramUserId: string, operationId: string): Promise<void> {
    const usuario = await this.resolveUser(telegramUserId);
    const result = await this.prisma.telegramWalletRequest.updateMany({
      where: { id: operationId, telegramUserId, usuarioId: usuario.idUsuario, confirmadoEm: null, expiraEm: { gt: new Date() } },
      data: { expiraEm: new Date(0) },
    });
    if (result.count !== 1) throw new ConflictException('Solicitação confirmada ou expirada.');
  }

  private async confirmRequest(
    telegramUserId: string,
    usuarioId: number,
    operationId: string,
  ): Promise<TelegramWalletRequest> {
    return this.prisma.$transaction(async (tx) => {
      // Keep the first snapshot read after the lock, including link validation.
      await tx.$queryRaw<{ id_usuario: number | bigint }[]>`
        SELECT id_usuario FROM USUARIO WHERE id_usuario = ${usuarioId} FOR UPDATE`;
      await this.assertActiveLink(tx, telegramUserId, usuarioId);
      const request = await this.findOwnedRequest(telegramUserId, usuarioId, operationId, tx);
      if (request.confirmadoEm) return request;

      const now = new Date();
      const result = await tx.telegramWalletRequest.updateMany({
        where: { id: operationId, telegramUserId, usuarioId, confirmadoEm: null, expiraEm: { gt: now } },
        data: { confirmadoEm: now },
      });
      const claimed = await this.findOwnedRequest(telegramUserId, usuarioId, operationId, tx);
      if (result.count !== 1 && !claimed.confirmadoEm) {
        throw new ConflictException('A confirmação expirou. Inicie uma nova solicitação.');
      }
      if (!claimed.confirmadoEm) throw new ConflictException('A confirmação não pôde ser registrada.');
      return claimed;
    });
  }

  private async linkRecarga(requestId: string, usuarioId: number, telegramUserId: string, recargaId: number): Promise<void> {
    const result = await this.prisma.telegramWalletRequest.updateMany({
      where: { id: requestId, usuarioId, telegramUserId, confirmadoEm: { not: null }, OR: [{ recargaId: null }, { recargaId }] },
      data: { recargaId },
    });
    if (result.count !== 1) throw new ConflictException('Não foi possível associar a cobrança à solicitação.');
  }

  private async findActiveRequest(
    telegramUserId: string,
    usuarioId: number,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const now = new Date();
    return tx.telegramWalletRequest.findFirst({
      where: {
        telegramUserId,
        usuarioId,
        OR: [
          { confirmadoEm: null, expiraEm: { gt: now } },
          { confirmadoEm: { not: null }, recargaId: null },
          { confirmadoEm: { not: null }, recarga: { is: { status: { in: [...ACTIVE_PAYMENT_STATUSES] } } } },
        ],
      },
      orderBy: { criadoEm: 'desc' },
      include: { recarga: true },
    });
  }

  private findOwnedRequest(
    telegramUserId: string,
    usuarioId: number,
    id: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return tx.telegramWalletRequest.findFirst({
      where: { id, telegramUserId, usuarioId },
      include: { recarga: true },
    }).then((request) => {
      if (!request) throw new NotFoundException('Solicitação de carteira não encontrada.');
      return request;
    });
  }

  private async resolveUser(telegramUserId: string) {
    const usuario = await this.links.resolveActiveUser(telegramUserId);
    if (!usuario) throw new UnauthorizedException('Vínculo POINT FFC inativo.');
    return usuario;
  }

  private async assertActiveLink(tx: Prisma.TransactionClient, telegramUserId: string, usuarioId: number): Promise<void> {
    const link = await tx.telegramAccountLink.findUnique({
      where: { telegramUserId },
      select: { usuarioId: true, usuario: { select: { status: true } } },
    });
    if (!link || link.usuarioId !== usuarioId || link.usuario.status !== 'ATIVO') {
      throw new UnauthorizedException('Vínculo POINT FFC inativo.');
    }
  }

  private view(request: Awaited<ReturnType<TelegramWalletService['findActiveRequest']>>): TelegramWalletOperationView {
    if (!request) throw new NotFoundException('Solicitação de carteira não encontrada.');
    return {
      id: request.id,
      usuarioId: request.usuarioId,
      valor: request.valor.toFixed(2),
      confirmado: request.confirmadoEm !== null,
      expiraEm: request.expiraEm,
      recarga: request.recarga ? this.payment(request.recarga) : null,
    };
  }

  private payment(payment: {
    id: number;
    valor: string | Prisma.Decimal;
    status: string;
    idPagamentoExterno: string | null;
    pixCopiaCola: string | null;
    qrCode: string | null;
    expiracao: Date | null;
  }): TelegramWalletPayment {
    return {
      id: payment.id,
      valor: typeof payment.valor === 'string' ? payment.valor : payment.valor.toFixed(2),
      status: payment.status,
      idPagamentoExterno: payment.idPagamentoExterno,
      pixCopiaCola: payment.pixCopiaCola,
      qrCode: payment.qrCode,
      expiracao: payment.expiracao,
    };
  }
}
