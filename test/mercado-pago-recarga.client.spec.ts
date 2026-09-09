import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { Order } from 'mercadopago';
import { MercadoPagoRecargaClient } from '../src/carteira/mercado-pago-recarga.client';

describe('MercadoPagoRecargaClient - SDK sem rede', () => {
  const settings: Record<string, string> = { MERCADO_PAGO_ACCESS_TOKEN: 'test-token', MERCADO_PAGO_WEBHOOK_SECRET: 'test-secret' };
  const client = new MercadoPagoRecargaClient({ get: (key: string) => settings[key] ?? '' } as ConfigService);
  afterEach(() => jest.restoreAllMocks());

  it('retry de criação mantém chave, corpo e pagador autenticado', async () => {
    const create = jest.spyOn(Order.prototype, 'create').mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ id: 'ORD1', api_response: { status: 201, headers: [] as never } });
    expect(await client.create('10.00', 'stable-reference', 'user@example.com')).toMatchObject({ id: 'ORD1' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create).toHaveBeenCalledWith({ body: {
      type: 'online', processing_mode: 'automatic', total_amount: '10.00', external_reference: 'stable-reference',
      payer: { email: 'user@example.com' }, transactions: { payments: [{ amount: '10.00', payment_method: { id: 'pix', type: 'bank_transfer' } }] },
    }, requestOptions: { timeout: 5000, maxRetries: 0, idempotencyKey: 'stable-reference' } });
  });

  it('valida assinatura oficial e rejeita assinatura inválida', () => {
    const ts = '1742505638683';
    const hash = createHmac('sha256', settings.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:ORD1;request-id:req-1;ts:${ts};`).digest('hex');
    expect(() => client.validateSignature(`ts=${ts},v1=${hash}`, 'req-1', 'ORD1')).not.toThrow();
    expect(() => client.validateSignature(`ts=${ts},v1=invalid`, 'req-1', 'ORD1')).toThrow('Assinatura');
    expect(() => client.validateSignature(undefined, undefined, 'ORD1')).toThrow('Assinatura');
    expect(() => client.validateSignature('anything', 'req-1', ['ORD1'])).toThrow('data.id');
  });

  it('consulta Order pelo identificador e sanitiza erros do SDK', async () => {
    const get = jest.spyOn(Order.prototype, 'get').mockRejectedValue(new Error('test-token QR-COMPLETO pix-copia-cola'));
    await expect(client.get('ORD1')).rejects.toThrow('Falha ao consultar ou criar Order Mercado Pago');
    expect(get).toHaveBeenCalledWith({ id: 'ORD1', requestOptions: { timeout: 5000, maxRetries: 0 } });
  });

  it('limita retries de criação e não expõe o erro externo', async () => {
    const create = jest.spyOn(Order.prototype, 'create').mockRejectedValue(new Error('test-secret'));
    await expect(client.create('1.00', 'stable', 'user@example.com')).rejects.toThrow('Falha ao consultar ou criar Order');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
