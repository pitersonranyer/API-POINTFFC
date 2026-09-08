import { BadGatewayException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import { InvalidWebhookSignatureError, MercadoPagoConfig, Order, WebhookSignatureValidator } from 'mercadopago';
import { OrderResult } from './poc-mercado-pago.types';

const OPTIONS = { timeout: 5000, maxRetries: 0 };
export const ORDER_ID = /^ORD[A-Z0-9]{1,64}$/;

@Injectable()
export class MercadoPagoClient {
  private readonly logger = new Logger(MercadoPagoClient.name);
  constructor(private readonly config: ConfigService) {}

  configured(): boolean {
    return Boolean(this.value('MERCADO_PAGO_ACCESS_TOKEN') && this.value('MERCADO_PAGO_WEBHOOK_SECRET')
      && isEmail(this.value('MERCADO_PAGO_POC_PAYER_EMAIL')));
  }

  assertConfigured(): void {
    if (!this.configured()) throw new ServiceUnavailableException(
      'POC Mercado Pago não configurada: defina MERCADO_PAGO_ACCESS_TOKEN, MERCADO_PAGO_WEBHOOK_SECRET e MERCADO_PAGO_POC_PAYER_EMAIL válido.');
  }

  create(valor: string, referencia: string, idempotencyKey: string): Promise<OrderResult> {
    this.assertConfigured();
    return this.request(() => this.order().create({ body: {
      type: 'online', processing_mode: 'automatic', total_amount: valor, external_reference: referencia,
      // Official PIX test scenario. This payer is exclusively for this removable POC.
      payer: { email: this.value('MERCADO_PAGO_POC_PAYER_EMAIL'), first_name: 'APRO' },
      transactions: { payments: [{ amount: valor, payment_method: { id: 'pix', type: 'bank_transfer' } }] },
    }, requestOptions: { ...OPTIONS, idempotencyKey } }));
  }

  get(id: string): Promise<OrderResult> {
    this.assertConfigured();
    if (!ORDER_ID.test(id)) throw new BadGatewayException('Identificador de Order inválido');
    return this.request(() => this.order().get({ id, requestOptions: OPTIONS }));
  }

  validateSignature(signature: string | undefined, requestId: string | undefined, dataId: string): void {
    this.assertConfigured();
    try {
      WebhookSignatureValidator.validate({ xSignature: signature, xRequestId: requestId,
        dataId, secret: this.value('MERCADO_PAGO_WEBHOOK_SECRET') });
    } catch (error) {
      if (!(error instanceof InvalidWebhookSignatureError)) throw error;
      this.logger.warn({ event: '[POC MercadoPago] assinatura de webhook inválida',
        reason: error.reason, dataId: ORDER_ID.test(dataId) ? dataId : 'invalido',
        signaturePresent: Boolean(signature?.trim()), requestIdPresent: Boolean(requestId?.trim()) });
      throw new UnauthorizedException('Assinatura do webhook inválida');
    }
  }

  private value(key: string): string { return this.config.get<string>(key, '').trim(); }

  private order(): Order {
    // SDK mutates request options; a fresh config avoids sharing idempotency keys between creations.
    return new Order(new MercadoPagoConfig({ accessToken: this.value('MERCADO_PAGO_ACCESS_TOKEN'), options: OPTIONS }));
  }

  private async request(call: () => Promise<OrderResult>): Promise<OrderResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Also bounds response-body parsing, beyond the SDK's network timeout.
      return await Promise.race([call(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), 6000);
      })]);
    } catch {
      this.logger.warn('[POC MercadoPago] falha na consulta externa');
      throw new BadGatewayException('Mercado Pago indisponível ou recusou a operação da POC');
    } finally { if (timer) clearTimeout(timer); }
  }
}
