import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import { InvalidWebhookSignatureError, MercadoPagoConfig, Order, WebhookSignatureValidator } from 'mercadopago';

export type RecargaOrder = Awaited<ReturnType<Order['get']>>;
export const RECARGA_ORDER_ID = /^ORD[A-Z0-9]{1,64}$/;
const OPTIONS = { timeout: 5000, maxRetries: 0 };

@Injectable()
export class MercadoPagoRecargaClient {
  constructor(private readonly config: ConfigService) {}

  assertConfigured() {
    if (!this.value('MERCADO_PAGO_ACCESS_TOKEN') || !this.value('MERCADO_PAGO_WEBHOOK_SECRET')) {
      throw new ServiceUnavailableException('Mercado Pago não configurado');
    }
  }

  async create(valor: string, externalReference: string, email: string): Promise<RecargaOrder> {
    this.assertConfigured();
    if (!isEmail(email)) throw new BadRequestException('E-mail do usuário inválido');
    // As duas tentativas usam exatamente o mesmo corpo e a mesma chave persistida.
    const body = { type: 'online', processing_mode: 'automatic', total_amount: valor, external_reference: externalReference,
      payer: { email }, transactions: { payments: [{ amount: valor, payment_method: { id: 'pix', type: 'bank_transfer' } }] } };
    const create = () => this.request(() => this.order().create({ body,
      requestOptions: { ...OPTIONS, idempotencyKey: externalReference } }));
    try { return await create(); } catch { return create(); }
  }

  get(id: string): Promise<RecargaOrder> {
    this.assertConfigured();
    if (!RECARGA_ORDER_ID.test(id)) throw new BadRequestException('data.id de Order inválido');
    return this.request(() => this.order().get({ id, requestOptions: OPTIONS }));
  }

  validateSignature(signature: string | undefined, requestId: string | undefined, dataId: unknown): asserts dataId is string {
    this.assertConfigured();
    if (typeof dataId !== 'string' || !RECARGA_ORDER_ID.test(dataId)) throw new BadRequestException('data.id de Order inválido');
    try {
      WebhookSignatureValidator.validate({ xSignature: signature, xRequestId: requestId,
        dataId, secret: this.value('MERCADO_PAGO_WEBHOOK_SECRET') });
    } catch (error) {
      if (!(error instanceof InvalidWebhookSignatureError)) throw error;
      throw new UnauthorizedException('Assinatura do webhook inválida');
    }
  }

  private value(key: string) { return this.config.get<string>(key, '').trim(); }
  private order() {
    return new Order(new MercadoPagoConfig({ accessToken: this.value('MERCADO_PAGO_ACCESS_TOKEN'), options: OPTIONS }));
  }
  private async request(call: () => Promise<RecargaOrder>): Promise<RecargaOrder> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([call(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), 6000);
      })]);
    } catch {
      // Não expõe resposta do SDK, dados PIX ou credenciais em erro/log.
      throw new BadGatewayException('Falha ao consultar ou criar Order Mercado Pago');
    } finally { if (timer) clearTimeout(timer); }
  }
}
