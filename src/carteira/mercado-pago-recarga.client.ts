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
    } catch (error) {
      this.registrarErroSeguro(error);
      throw new BadGatewayException('Falha ao consultar ou criar Order Mercado Pago');
    } finally { if (timer) clearTimeout(timer); }
  }

  private registrarErroSeguro(error: unknown): void {
    try {
      const record = (value: unknown): Record<string, unknown> =>
        value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
      const root = record(error);
      const response = record(root.response);
      const secrets = [this.value('MERCADO_PAGO_ACCESS_TOKEN'), this.value('MERCADO_PAGO_WEBHOOK_SECRET')].filter(Boolean);
      const text = (value: unknown): string | number | undefined => {
        if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
        if (typeof value !== 'string') return undefined;
        let safe = value;
        for (const secret of secrets) safe = safe.split(secret).join('[omitido]');
        // Mensagens que possam conter payload ou dados pessoais são omitidas por inteiro.
        if (/[{}\[\]]/.test(safe.replace(/\[omitido\]/g, '')) ||
          /\b(?:qr|pix|payer|authorization|bearer|token|secret|cpf|cnpj|phone|address|password|first_name|last_name|identification)\b/i.test(safe) ||
          /qr[_-]?code|copia.?cola|access[_-]?token|webhook[_-]?secret/i.test(safe)) {
          return '[conteúdo sensível omitido]';
        }
        return safe.replace(/https?:\/\/\S+/gi, '[url omitida]')
          .replace(/[^\s<>"']+@[^\s<>"']+/g, '[email omitido]')
          .replace(/\b\d[\d.\s/-]{9,}\d\b/g, '[documento omitido]')
          .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[valor longo omitido]')
          .replace(/[\r\n\t]/g, ' ').slice(0, 400);
      };
      const fields = (value: unknown, depth = 0): unknown => {
        if (depth > 3) return undefined;
        if (Array.isArray(value)) return value.slice(0, 5).map((item) => fields(item, depth + 1));
        if (value === null || typeof value !== 'object') return text(value);
        const source = record(value);
        const selected: Record<string, unknown> = {};
        for (const key of ['name', 'message', 'error', 'code', 'description', 'cause', 'causes']) {
          const sanitized = key === 'cause' || key === 'causes' ? fields(source[key], depth + 1) : text(source[key]);
          if (sanitized !== undefined) selected[key] = sanitized;
        }
        return selected;
      };
      const body = record(response.data ?? response.body ?? root.body);
      const status = [root.status, root.statusCode, response.status, body.status]
        .find((value) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599);
      console.error(JSON.stringify({ event: 'MERCADO_PAGO_ORDER_ERROR', level: 'error',
        ...record(fields(error)), name: text(root.name ?? (error instanceof Error ? error.constructor.name : 'UnknownError')),
        ...(status !== undefined ? { status } : {}),
        ...(Object.keys(body).length ? { response: fields(body) } : {}),
      }));
    } catch {
      // Erros inesperados na inspeção não devem substituir a resposta pública original.
      console.error(JSON.stringify({ event: 'MERCADO_PAGO_ORDER_ERROR', level: 'error', message: 'Detalhes do erro indisponíveis' }));
    }
  }
}
