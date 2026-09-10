import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { Order } from 'mercadopago';
import { MercadoPagoRecargaClient } from '../src/carteira/mercado-pago-recarga.client';

describe('MercadoPagoRecargaClient - SDK sem rede', () => {
  const settings: Record<string, string> = { MERCADO_PAGO_ACCESS_TOKEN: 'test-token', MERCADO_PAGO_WEBHOOK_SECRET: 'test-secret' };
  const client = new MercadoPagoRecargaClient({ get: (key: string) => settings[key] ?? '' } as ConfigService);
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('retry de criação mantém chave, corpo e pagador autenticado', async () => {
    const create = jest.spyOn(Order.prototype, 'create').mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ id: 'ORD1', api_response: { status: 201, headers: [] as never } });
    expect(await client.create('10.00', 'stable-reference', 'user@example.com')).toMatchObject({ id: 'ORD1' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create).toHaveBeenCalledWith({ body: {
      type: 'online', processing_mode: 'automatic', total_amount: '10.00', external_reference: 'stable-reference',
      items: [{ title: 'Recarga carteira PointFFC', quantity: 1, unit_price: '10.00', category_id: 'services' }],
      payer: { email: 'user@example.com' }, transactions: { payments: [{ amount: '10.00', payment_method: { id: 'pix', type: 'bank_transfer' } }] },
    }, requestOptions: { timeout: 5000, maxRetries: 0, idempotencyKey: 'stable-reference' } });
  });

  it.each(['0.01', '10.25', '9999999999.99'])('item preserva exatamente o valor textual %s', async (valor) => {
    const create = jest.spyOn(Order.prototype, 'create').mockResolvedValue({ id: 'ORD1', api_response: { status: 201, headers: [] as never } });
    await client.create(valor, 'stable-reference', 'user@example.com');
    const body = create.mock.calls[0][0].body;
    expect(body.items).toEqual([{ title: 'Recarga carteira PointFFC', quantity: 1, unit_price: valor, category_id: 'services' }]);
    expect(body.items![0].unit_price).toBe(body.total_amount);
    expect(body.items![0].unit_price).toBe(body.transactions!.payments![0].amount);
    expect(body.payer).toEqual({ email: 'user@example.com' });
    expect(body.payer).not.toHaveProperty('last_name');
  });

  it('valida assinatura oficial e rejeita assinatura inválida', () => {
    const ts = '1742505638683';
    const hash = createHmac('sha256', settings.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:ord1;request-id:req-1;ts:${ts};`).digest('hex');
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

  it('registra classe, status e causas do SDK mantendo a resposta pública', async () => {
    const error = Object.assign(new Error('Invalid request parameters'), {
      name: 'MPBadRequestError', status: 400, error: 'bad_request',
      causes: [{ code: 'invalid_parameter', description: 'Missing required field' }],
    });
    jest.spyOn(Order.prototype, 'create').mockRejectedValue(error);
    await expect(client.create('10.00', 'stable-reference', 'user@example.com')).rejects.toThrow('Falha ao consultar ou criar Order Mercado Pago');
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(JSON.parse(jest.mocked(console.error).mock.calls[0][0])).toEqual({ event: 'MERCADO_PAGO_ORDER_ERROR', level: 'error',
      name: 'MPBadRequestError', message: 'Invalid request parameters', status: 400, error: 'bad_request',
      causes: [{ code: 'invalid_parameter', description: 'Missing required field' }],
    });
    for (const args of jest.mocked(console.error).mock.calls) {
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe('string');
      expect(args[0]).not.toMatch(/[\r\n]/);
    }
  });

  it('omite credenciais, PIX, pagador, headers e payload mesmo em campos de mensagem', async () => {
    const error = Object.assign(new Error('test-token test-secret user@example.com'), {
      name: 'MPValidationError', code: 'validation_error',
      cause: [{ code: 'invalid_data', message: 'payer John Silva CPF 123.456.789-00 QR qr-secret PIX copy-secret' }],
      response: { status: 422, headers: { authorization: 'Bearer test-token' }, data: {
        error: 'validation_error', message: 'Invalid data for user@example.com',
        cause: [{ code: 'bad_field', description: 'qr_code_base64=qr-secret pixCopiaCola=copy-secret' }],
        access_token: 'test-token', webhook_secret: 'test-secret', qr_code: 'copy-secret', qr_code_base64: 'qr-secret',
        payer: { email: 'user@example.com', first_name: 'John', last_name: 'Silva', identification: { number: '12345678900' } },
      } },
      request: { body: 'payload completo', headers: { authorization: 'Bearer test-token' } },
    });
    jest.spyOn(Order.prototype, 'get').mockRejectedValue(error);
    await expect(client.get('ORD1')).rejects.toThrow('Falha ao consultar ou criar Order Mercado Pago');
    const logs = jest.mocked(console.error).mock.calls.map(([line]) => line).join('\n');
    for (const secret of ['test-token', 'test-secret', 'user@example.com', 'qr-secret', 'copy-secret', 'John', 'Silva', '12345678900', '123.456.789-00', 'payload completo']) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toMatch(/authorization|"headers"|"request"|"stack"/);
    expect(JSON.parse(jest.mocked(console.error).mock.calls[0][0])).toEqual(expect.objectContaining({ status: 422, code: 'validation_error',
      response: expect.objectContaining({ error: 'validation_error', message: 'Invalid data for [email omitido]' }) }));
  });

  it('limita tamanho, profundidade e quantidade de causas e tolera causa circular', async () => {
    const error: any = { name: 'Error', message: 'timeout '.repeat(200), causes: Array.from({ length: 20 }, () => ({ code: 'timeout' })) };
    error.cause = error;
    jest.spyOn(Order.prototype, 'get').mockRejectedValue(error);
    await expect(client.get('ORD1')).rejects.toThrow('Falha ao consultar ou criar Order Mercado Pago');
    const log = JSON.parse(jest.mocked(console.error).mock.calls[0][0]);
    expect(log.message.length).toBeLessThanOrEqual(400);
    expect(log.causes).toHaveLength(5);
  });

  it('fallback emite somente JSON seguro em uma linha e preserva 502', async () => {
    const error = Object.defineProperty({}, 'response', { get() { throw new Error('detalhe privado'); } });
    jest.spyOn(Order.prototype, 'get').mockRejectedValue(error);
    await expect(client.get('ORD1')).rejects.toThrow('Falha ao consultar ou criar Order Mercado Pago');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({ event: 'MERCADO_PAGO_ORDER_ERROR', level: 'error', message: 'Detalhes do erro indisponíveis' }));
  });
});
