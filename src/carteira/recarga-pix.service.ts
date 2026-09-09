import { BadGatewayException, BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Prisma, RecargaCarteira, Usuario } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CarteiraService, RecargaPixOficial } from './carteira.service';
import { RecargaCarteiraService } from './recarga-carteira.service';
import { MercadoPagoRecargaClient, RECARGA_ORDER_ID, RecargaOrder } from './mercado-pago-recarga.client';
import { mapRecargaOrderStatus } from './mercado-pago-recarga-status';

@Injectable()
export class RecargaPixService {
  private readonly logger = new Logger(RecargaPixService.name);
  constructor(private readonly prisma: PrismaService, private readonly carteiras: CarteiraService,
    private readonly recargas: RecargaCarteiraService, private readonly client: MercadoPagoRecargaClient) {}

  criar(usuario: Pick<Usuario, 'idUsuario' | 'email'>, valor: string, idempotencyKey: string | undefined) {
    return this.executar(async () => {
      this.client.assertConfigured();
      if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(idempotencyKey)) {
        throw new BadRequestException('Informe Idempotency-Key de 16 a 128 caracteres alfanuméricos, hífen ou underscore');
      }
      if (typeof valor !== 'string' || !/^\d+(\.\d{1,2})?$/.test(valor) ||
        new Prisma.Decimal(valor).lte(0) || new Prisma.Decimal(valor).gt('9999999999.99')) {
        throw new BadRequestException('Valor decimal inválido');
      }
      const externalReference = createHash('sha256').update(`${usuario.idUsuario}:${idempotencyKey}`).digest('hex');
      const carteira = await this.carteiras.obterOuCriar(usuario.idUsuario);
      let recarga = await this.recargas.consultarPorExternalReference(externalReference);
      if (!recarga) {
        if (carteira.status !== 'ATIVA') throw new BadRequestException('Carteira bloqueada');
        try {
          recarga = await this.recargas.criar({ carteiraId: carteira.id, valor, provedor: 'MERCADO_PAGO', externalReference });
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          // UNIQUE externalReference resolve também dois POSTs simultâneos com a mesma chave.
          recarga = await this.recargas.consultarPorExternalReference(externalReference);
          if (!recarga) throw error;
        }
      }
      if (recarga.carteiraId !== carteira.id || recarga.provedor !== 'MERCADO_PAGO' || !recarga.valor.equals(valor)) {
        throw new ConflictException('Idempotency-Key já utilizada para outra recarga/valor');
      }
      if (recarga.idPagamentoExterno) return this.sincronizar(recarga);
      if (carteira.status !== 'ATIVA') throw new BadRequestException('Carteira bloqueada');
      console.error(JSON.stringify({ marker: 'RECARGA_PIX_BEFORE_MP_CREATE', level: 'error',
        timestamp: new Date().toISOString(), usuarioId: usuario.idUsuario, recargaId: recarga.id }));
      const order = await this.client.create(recarga.valor.toFixed(2), recarga.externalReference, usuario.email);
      const oficial = this.validarOrder(recarga, order);
      // Guarda o vínculo antes do crédito, para permitir retry de webhook se o crédito falhar.
      await this.prisma.recargaCarteira.updateMany({ where: { id: recarga.id, idPagamentoExterno: null },
        data: { idPagamentoExterno: oficial.idPagamentoExterno } });
      return this.resposta(await this.carteiras.aplicarRecargaPix(recarga.id, oficial));
    });
  }

  consultar(usuarioId: number, id: number) {
    return this.executar(async () => {
      const recarga = await this.prisma.recargaCarteira.findFirst({ where: { id, carteira: { usuarioId }, provedor: 'MERCADO_PAGO' } });
      if (!recarga) throw new NotFoundException('Recarga não encontrada');
      return recarga.idPagamentoExterno ? this.sincronizar(recarga) : this.resposta(recarga);
    });
  }

  webhook(signature: string | undefined, requestId: string | undefined, dataId: unknown) {
    return this.executar(async () => {
      let etapa = 'assinatura';
      const context: { orderId?: string; recargaId?: number } = {};
      const log = (marker: string, fields: Record<string, unknown> = {}) => {
        console.error(JSON.stringify({ marker, level: 'error', timestamp: new Date().toISOString(), ...context, ...fields }));
      };
      const statusSeguro = (value: unknown) => typeof value === 'string' && [
        'created', 'processing', 'in_process', 'action_required', 'waiting_transfer', 'processed', 'accredited',
        'approved', 'rejected', 'failed', 'processing_error', 'canceled', 'cancelled', 'expired', 'refunded',
        'partially_refunded', 'charged_back', 'ATIVA', 'PENDENTE', 'PROCESSANDO', 'APROVADA', 'REJEITADA',
        'CANCELADA', 'EXPIRADA', 'REEMBOLSADA',
      ].includes(value) ? value : value == null ? 'ausente' : 'desconhecido';
      try {
        if (typeof dataId === 'string' && RECARGA_ORDER_ID.test(dataId)) {
          context.orderId = dataId;
          log('WEBHOOK_CARTEIRA_ORDER_ID');
        }
        this.client.validateSignature(signature, requestId, dataId);
        log('WEBHOOK_CARTEIRA_ASSINATURA_OK');
        etapa = 'consulta_order';
        const order = await this.client.get(dataId);
        log('WEBHOOK_CARTEIRA_ORDER_CONSULTADA');
        log('WEBHOOK_CARTEIRA_STATUS', { status: statusSeguro(order.status), status_detail: statusSeguro(order.status_detail) });
        etapa = 'validacao_order_id';
        if (order.id !== dataId) throw new BadGatewayException('Order retornada não corresponde à solicitada');
        etapa = 'localizacao_recarga';
        const recarga = await this.recargas.consultarPorIdPagamentoExterno(dataId);
        if (recarga) context.recargaId = recarga.id;
        log('WEBHOOK_CARTEIRA_RECARGA_LOCALIZADA', { localizada: Boolean(recarga) });
        if (!recarga) {
          this.logger.log({ event: 'Order sem recarga vinculada; ignorada', orderId: dataId });
          log('WEBHOOK_CARTEIRA_PROCESSADA', { resultado: 'ignorada_sem_recarga' });
          return { received: true };
        }
        etapa = 'validacao_order';
        const oficial = this.validarOrder(recarga, order);
        etapa = 'processamento_recarga';
        const resultado = await this.carteiras.aplicarRecargaPix(recarga.id, oficial);
        log('WEBHOOK_CARTEIRA_PROCESSADA', { resultado: 'ok', status: statusSeguro(resultado.status) });
        return { received: true };
      } catch (error) {
        log('WEBHOOK_CARTEIRA_ERRO', { etapa, httpStatus: error instanceof HttpException ? error.getStatus() : 503,
          categoria: error instanceof UnauthorizedException ? 'assinatura_invalida' : error instanceof HttpException ? 'erro_http' : 'erro_interno' });
        throw error;
      }
    });
  }

  private async sincronizar(recarga: RecargaCarteira) {
    const order = await this.client.get(recarga.idPagamentoExterno!);
    return this.resposta(await this.carteiras.aplicarRecargaPix(recarga.id, this.validarOrder(recarga, order)));
  }

  private validarOrder(recarga: RecargaCarteira, order: RecargaOrder): RecargaPixOficial {
    if (!order.id || !RECARGA_ORDER_ID.test(order.id) ||
      (recarga.idPagamentoExterno !== null && recarga.idPagamentoExterno !== order.id) ||
      recarga.provedor !== 'MERCADO_PAGO' || order.external_reference !== recarga.externalReference ||
      typeof order.total_amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(order.total_amount) ||
      !recarga.valor.equals(order.total_amount) || typeof order.status !== 'string') {
      throw new BadGatewayException('Order incompatível com a recarga');
    }
    const payment = order.transactions?.payments?.find((p) => p.payment_method?.id === 'pix');
    const expiracao = payment?.date_of_expiration ? new Date(payment.date_of_expiration) : undefined;
    if (expiracao && !Number.isFinite(expiracao.getTime())) throw new BadGatewayException('Expiração PIX inválida');
    return { idPagamentoExterno: order.id, externalReference: order.external_reference,
      valor: new Prisma.Decimal(order.total_amount), status: mapRecargaOrderStatus(order.status, order.status_detail),
      pixCopiaCola: payment?.payment_method?.qr_code, qrCode: payment?.payment_method?.qr_code_base64, expiracao };
  }

  private resposta(recarga: RecargaCarteira) {
    return { id: recarga.id, valor: recarga.valor.toFixed(2), status: recarga.status,
      idPagamentoExterno: recarga.idPagamentoExterno, pixCopiaCola: recarga.pixCopiaCola,
      qrCode: recarga.qrCode, expiracao: recarga.expiracao, criadoEm: recarga.criadoEm,
      atualizadoEm: recarga.atualizadoEm, aprovadoEm: recarga.aprovadoEm };
  }

  private async executar<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof HttpException) throw error;
      // Prisma pode incluir argumentos da consulta no erro: nunca expor/logar esses dados PIX.
      throw new ServiceUnavailableException('Falha ao processar recarga; tente novamente com a mesma chave');
    }
  }
}
