import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MercadoPagoClient, ORDER_ID } from './mercado-pago.client';
import { mapOrderStatus, PocPixStatus } from './mercado-pago-status';
import { OrderResult, PixData, PocPix, PocPixResponse } from './poc-mercado-pago.types';

const LOG_STATUSES = new Set(['created', 'processing', 'action_required', 'processed', 'approved',
  'rejected', 'canceled', 'cancelled', 'expired', 'failed', 'refunded', 'charged_back']);
const safeStatus = (value: unknown): string => typeof value === 'string' && LOG_STATUSES.has(value) ? value : 'desconhecido';

@Injectable()
export class PocMercadoPagoService {
  private readonly logger = new Logger(PocMercadoPagoService.name);
  private readonly byId = new Map<string, PocPix>();
  private readonly byExternalId = new Map<string, string>();
  private readonly refreshing = new Map<string, Promise<void>>();
  constructor(private readonly client: MercadoPagoClient) {}

  health() { return { status: 'ok', mercadoPagoConfigured: this.client.configured() }; }

  async create(valor: number): Promise<PocPixResponse> {
    this.client.assertConfigured();
    const id = randomUUID();
    const referencia = `poc-pix-${id}`;
    const amount = valor.toFixed(2);
    const order = await this.client.create(amount, referencia, id);
    if (!order.id || !ORDER_ID.test(order.id) || this.byExternalId.has(order.id)) {
      throw new BadGatewayException('Resposta de criação da Order inválida');
    }
    const now = new Date().toISOString();
    const record: PocPix = { id, idExterno: order.id, referencia, valor: amount,
      status: PocPixStatus.PROCESSANDO, pix: {}, criadoEm: now, atualizadoEm: now };
    this.apply(record, order);
    this.byId.set(id, record);
    this.byExternalId.set(order.id, id);
    this.logger.log(`[POC MercadoPago] PIX criado idInterno=${id} externalId=${order.id}`);
    return this.response(record);
  }

  async status(id: string): Promise<PocPixResponse> {
    this.client.assertConfigured();
    const record = this.byId.get(id);
    if (!record) throw new NotFoundException('PIX não encontrado na memória desta instância da POC');
    await this.refresh(record.idExterno);
    return this.response(record);
  }

  async webhook(signature: string | undefined, requestId: string | undefined, dataId: unknown, body?: unknown): Promise<{ received: true }> {
    const safeRequestId = requestId?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) ?? 'ausente';
    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const action = typeof payload.action === 'string' && payload.action.startsWith('order.')
      && LOG_STATUSES.has(payload.action.slice(6)) ? payload.action : 'desconhecida';
    const context = { requestId: safeRequestId, dataId: typeof dataId === 'string' && ORDER_ID.test(dataId) ? dataId : 'invalido',
      action, type: payload.type === 'order' ? 'order' : 'desconhecido' };
    this.logger.log({ event: '[POC MercadoPago] webhook recebido', ...context });
    let result = 'erro';
    try {
      this.client.assertConfigured();
      if (typeof dataId !== 'string' || !ORDER_ID.test(dataId)) throw new BadRequestException('data.id de Order inválido');
      this.client.validateSignature(signature, requestId, dataId);
      this.logger.log({ event: '[POC MercadoPago] assinatura validada', ...context });
      // Body metadata is logged only; the signed query ID selects the official resource.
      await this.refresh(dataId);
      result = 'ok';
      return { received: true };
    } finally { this.logger.log({ event: '[POC MercadoPago] webhook finalizado', ...context, resultado: result }); }
  }

  private async refresh(externalId: string): Promise<void> {
    const pending = this.refreshing.get(externalId);
    if (pending) return pending;
    const operation = (async () => {
      const order = await this.client.get(externalId);
      if (order.id !== externalId) throw new BadGatewayException('Order retornada não corresponde à solicitada');
      this.logger.log({ event: '[POC MercadoPago] Order consultada', dataId: externalId,
        statusOficial: safeStatus(order.status), statusInterno: mapOrderStatus(order.status, order.status_detail) });
      // Look up after the await: creation may have finished while its webhook was in flight.
      const id = this.byExternalId.get(externalId);
      const record = id ? this.byId.get(id) : undefined;
      if (record) {
        this.logger.log({ event: '[POC MercadoPago] pagamento interno localizado', dataId: externalId, idInterno: record.id });
        this.apply(record, order);
      } else {
        this.logger.log({ event: '[POC MercadoPago] Order ausente da memória; nenhuma transação criada', dataId: externalId });
      }
    })();
    this.refreshing.set(externalId, operation);
    try { await operation; } finally { this.refreshing.delete(externalId); }
  }

  private apply(record: PocPix, order: OrderResult): void {
    if (order.external_reference !== record.referencia || order.total_amount !== record.valor
      || typeof order.status !== 'string') throw new BadGatewayException('Dados da Order inconsistentes com a POC');
    const updated = order.last_updated_date;
    if (updated && record.atualizadoNoProvedor && Date.parse(updated) < Date.parse(record.atualizadoNoProvedor)) return;
    const payment = order.transactions?.payments?.find((p) => p.payment_method?.id === 'pix');
    const pix: PixData = { ...record.pix };
    if (payment?.payment_method?.qr_code) pix.copiaCola = payment.payment_method.qr_code;
    if (payment?.payment_method?.qr_code_base64) pix.qrCodeBase64 = payment.payment_method.qr_code_base64;
    if (payment?.date_of_expiration) pix.expiracao = payment.date_of_expiration;
    const status = mapOrderStatus(order.status, order.status_detail);
    if (status !== record.status) this.logger.log(`[POC MercadoPago] idInterno=${record.id} status ${record.status} -> ${status}`);
    if (status !== record.status || JSON.stringify(pix) !== JSON.stringify(record.pix)) record.atualizadoEm = new Date().toISOString();
    record.status = status;
    record.pix = pix;
    if (updated && Number.isFinite(Date.parse(updated))) record.atualizadoNoProvedor = updated;
  }

  private response(record: PocPix): PocPixResponse {
    return { id: record.id, idExterno: record.idExterno, status: record.status, valor: Number(record.valor),
      pix: { ...record.pix }, atualizadoEm: record.atualizadoEm };
  }
}
