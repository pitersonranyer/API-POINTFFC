import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { Order } from 'mercadopago';
import { MercadoPagoClient } from './mercado-pago.client';
import { mapOrderStatus } from './mercado-pago-status';
import { PocMercadoPagoModule } from './poc-mercado-pago.module';
import { PocMercadoPagoService } from './poc-mercado-pago.service';
import { OrderResult } from './poc-mercado-pago.types';
import { environmentValidationSchema } from '../../config/environment.validation';

const settings = { MERCADO_PAGO_ACCESS_TOKEN: 'test-token-not-real', MERCADO_PAGO_WEBHOOK_SECRET: 'test-secret-not-real',
  MERCADO_PAGO_POC_PAYER_EMAIL: 'test_user_br@testuser.com' };
const externalId = 'ORD01JP84C939T20S0P1DN382FQ6K';
function signature(id = externalId, secret = settings.MERCADO_PAGO_WEBHOOK_SECRET) {
  const ts = '1742505638683';
  const hash = createHmac('sha256', secret).update(`id:${id};request-id:request-1;ts:${ts};`).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${hash}`, 'x-request-id': 'request-1' };
}

describe('POC PIX isolada: HTTP, SDK e memória, sem banco', () => {
  let app: INestApplication;
  let base: string;
  let current: OrderResult;
  let create: jest.SpyInstance;
  let get: jest.SpyInstance;
  let logs: jest.SpyInstance;
  beforeEach(async () => {
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    create = jest.spyOn(Order.prototype, 'create').mockImplementation(async ({ body }) => {
      current = { id: externalId, type: 'online', total_amount: body.total_amount,
        external_reference: body.external_reference, status: 'processing', status_detail: 'in_process',
        last_updated_date: '2026-09-08T12:00:00Z', api_response: { status: 201, headers: [] as never } };
      return current;
    });
    get = jest.spyOn(Order.prototype, 'get').mockImplementation(async () => current);
    const module = await Test.createTestingModule({ imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => settings] }),
      PocMercadoPagoModule,
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterEach(async () => { await app?.close(); jest.restoreAllMocks(); });
  async function post(body: unknown) {
    return fetch(`${base}/poc/mercado-pago/pix`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function newPix() {
    const result = await post({ valor: 10 });
    expect(result.status).toBe(201);
    return result.json() as Promise<{ id: string; status: string; pix: object }>;
  }
  function webhook(headers = signature(), id = externalId) {
    return fetch(`${base}/webhooks/mercado-pago?data.id=${id}&type=order`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'order.processed', type: 'order', data: { id: 'ORDOTHER' }, status: 'approved', extra: 'ignored' }) });
  }
  function addQr() {
    current = { ...current, status: 'action_required', status_detail: 'waiting_transfer', transactions: { payments: [{
      payment_method: { id: 'pix', qr_code: 'test-copy-code', qr_code_base64: 'test-base64' },
      date_of_expiration: '2026-09-09T12:00:00Z',
    }] } };
  }
  it.each([
    ['action_required', 'waiting_transfer', 'PENDENTE'],
    ['processed', 'accredited', 'APROVADO'],
    ['approved', 'accredited', 'APROVADO'],
  ])('criação %s armazena %s como %s antes de webhook', async (status, detail, expected) => {
    const original = create.getMockImplementation()!;
    create.mockImplementation(async (input) => {
      await original(input);
      addQr();
      current = { ...current, status, status_detail: detail };
      return current;
    });
    const pix = await newPix();
    expect(pix).toMatchObject({ status: expected, pix: { copiaCola: 'test-copy-code', qrCodeBase64: 'test-base64' } });
    expect(get).not.toHaveBeenCalled();
    expect(await (await fetch(`${base}/poc/mercado-pago/pix/${pix.id}/status`)).json()).toMatchObject({ status: expected });
  });
  it('webhook conclui pendente -> aprovado antes do polling e registra etapas seguras', async () => {
    const pix = await newPix(); addQr(); await webhook();
    logs.mockClear();
    current = { ...current, status: 'processed', status_detail: 'accredited' };
    expect((await webhook()).status).toBe(200);
    expect(logs).toHaveBeenCalledWith(expect.stringContaining('PENDENTE -> APROVADO'));
    for (const event of ['webhook recebido', 'assinatura validada', 'Order consultada', 'pagamento interno localizado', 'webhook finalizado']) {
      expect(logs).toHaveBeenCalledWith(expect.objectContaining({ event: `[POC MercadoPago] ${event}`, dataId: externalId }));
    }
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ action: 'order.processed', type: 'order', resultado: 'ok' }));
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/test-token|test-secret|test-copy-code|test-base64/);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(signature()['x-signature']);
    expect(await (await fetch(`${base}/poc/mercado-pago/pix/${pix.id}/status`)).json()).toMatchObject({ status: 'APROVADO' });
  });
  it('health público não consulta API externa', async () => {
    expect(await (await fetch(`${base}/poc/mercado-pago/health`)).json()).toEqual({ status: 'ok', mercadoPagoConfigured: true });
    expect(create).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it.each([{}, { valor: 0 }, { valor: -1 }, { valor: '10' }, { valor: null }, { valor: 1.001 },
    { valor: 10001 }, { valor: true }, { valor: 10, usuarioId: 1 }, { valor: 10, url: 'https://example.com' }])('rejeita valor/campos inválidos: %j', async (body) => {
    expect((await post(body)).status).toBe(400); expect(create).not.toHaveBeenCalled();
  });
  it('cria Order idempotente com valor decimal, sem exigir QR inicial', async () => {
    const pix = await newPix();
    expect(pix).toMatchObject({ status: 'PROCESSANDO', valor: 10, pix: {} });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ total_amount: '10.00', external_reference: `poc-pix-${pix.id}`,
        payer: { email: settings.MERCADO_PAGO_POC_PAYER_EMAIL, first_name: 'APRO' } }),
      requestOptions: { timeout: 5000, maxRetries: 0, idempotencyKey: pix.id },
    }));
    expect(JSON.stringify(pix)).not.toContain('test-token');
  });
  it('polling atualiza QR assíncrono, expiração e aprovação', async () => {
    const pix = await newPix(); addQr();
    const url = `${base}/poc/mercado-pago/pix/${pix.id}/status`;
    expect(await (await fetch(url)).json()).toMatchObject({ status: 'PENDENTE', pix: {
      copiaCola: 'test-copy-code', qrCodeBase64: 'test-base64', expiracao: '2026-09-09T12:00:00Z',
    } });
    current = { ...current, status: 'processed', status_detail: 'accredited' };
    expect(await (await fetch(url)).json()).toMatchObject({ status: 'APROVADO', pix: { copiaCola: 'test-copy-code' } });
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('webhook válido consulta o ID assinado e ignora ID/status do corpo', async () => {
    const pix = await newPix(); addQr();
    expect((await webhook()).status).toBe(200);
    expect(get).toHaveBeenCalledWith({ id: externalId, requestOptions: { timeout: 5000, maxRetries: 0 } });
    expect(await (await fetch(`${base}/poc/mercado-pago/pix/${pix.id}/status`)).json()).toMatchObject({ status: 'PENDENTE' });
    current = { ...current, status: 'processed', status_detail: 'accredited' };
    expect((await webhook()).status).toBe(200);
    expect(await (await fetch(`${base}/poc/mercado-pago/pix/${pix.id}/status`)).json()).toMatchObject({ status: 'APROVADO' });
  });
  it('webhook inválido não consulta nem atualiza estado', async () => {
    const pix = await newPix();
    expect((await webhook(signature(externalId, 'wrong'))).status).toBe(401);
    expect((await webhook({} as ReturnType<typeof signature>)).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    expect(await (await fetch(`${base}/poc/mercado-pago/pix/${pix.id}/status`)).json()).toMatchObject({ status: 'PROCESSANDO' });
  });
  it('webhook repetido não recria PIX nem repete transição', async () => {
    const pix = await newPix(); addQr(); await webhook();
    const url = `${base}/poc/mercado-pago/pix/${pix.id}/status`;
    const before = await (await fetch(url)).json();
    await webhook();
    expect(await (await fetch(url)).json()).toEqual(before);
    expect(create).toHaveBeenCalledTimes(1);
    expect(logs.mock.calls.filter(([message]) => String(message).includes('PROCESSANDO -> PENDENTE'))).toHaveLength(1);
  });
  it('rejeita ID inválido, ausente, duplicado na query e PIX desconhecido', async () => {
    expect((await webhook(signature(), '../../etc')).status).toBe(400);
    expect((await fetch(`${base}/webhooks/mercado-pago`, { method: 'POST' })).status).toBe(400);
    expect((await fetch(`${base}/webhooks/mercado-pago?data.id=${externalId}&data.id=${externalId}`, { method: 'POST' })).status).toBe(400);
    expect((await fetch(`${base}/poc/mercado-pago/pix/00000000-0000-4000-8000-000000000000/status`)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
  it('Order desconhecida após restart é consultada mas não cria registro', async () => {
    current = { id: externalId, status: 'processed' } as OrderResult;
    expect((await webhook()).status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled();
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({
      event: '[POC MercadoPago] Order ausente da memória; nenhuma transação criada', dataId: externalId,
    }));
  });
  it('erro externo é seguro e webhook retorna erro para permitir reenvio', async () => {
    const pix = await newPix();
    get.mockRejectedValue(new Error('test-token-not-real test-copy-code'));
    expect((await webhook()).status).toBe(502);
    const result = await fetch(`${base}/poc/mercado-pago/pix/${pix.id}/status`);
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain('test-token');
    create.mockRejectedValue(new Error('test-secret-not-real'));
    expect((await post({ valor: 10 })).status).toBe(502);
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/test-token|test-secret|test-copy-code|test-base64/);
  });
  it('não aplica resposta de outra Order ou referência/valor divergente', async () => {
    await newPix();
    const original = current;
    for (const change of [{ id: 'ORDOTHER' }, { external_reference: 'other' }, { total_amount: '20.00' }]) {
      current = { ...original, ...change };
      expect((await webhook()).status).toBe(502);
    }
  });
  it('ignora versão anterior e preserva QR se resposta posterior o omitir', async () => {
    const pix = await newPix(); addQr();
    current = { ...current, status: 'processed', status_detail: 'accredited', last_updated_date: '2026-09-08T14:00:00Z' };
    await webhook();
    current = { ...current, status: 'processing', last_updated_date: '2026-09-08T13:00:00Z', transactions: undefined };
    const response = await (await fetch(`${base}/poc/mercado-pago/pix/${pix.id}/status`)).json();
    expect(response).toMatchObject({ status: 'APROVADO', pix: { copiaCola: 'test-copy-code' } });
  });
  it('consultas concorrentes da mesma Order compartilham a chamada externa', async () => {
    const pix = await newPix();
    let resolve!: (value: OrderResult) => void;
    get.mockImplementation(() => new Promise<OrderResult>((done) => { resolve = done; }));
    const service = app.get(PocMercadoPagoService);
    const first = service.status(pix.id);
    const second = service.status(pix.id);
    expect(get).toHaveBeenCalledTimes(1);
    resolve(current); await Promise.all([first, second]);
  });
});

describe('Configuração e transporte do SDK', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  it.each([
    [undefined, 'MissingSignatureHeader'], ['garbage', 'MalformedSignatureHeader'],
    [signature(externalId, 'wrong')['x-signature'], 'SignatureMismatch'],
  ])('diagnostica assinatura inválida sem revelar seu conteúdo: %s', (header, reason) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = new MercadoPagoClient(new ConfigService(settings));
    expect(() => client.validateSignature(header, 'request-1', externalId)).toThrow('Assinatura do webhook inválida');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason, dataId: externalId,
      signaturePresent: Boolean(header), requestIdPresent: true }));
    const output = JSON.stringify(warn.mock.calls);
    expect(output).not.toContain(settings.MERCADO_PAGO_WEBHOOK_SECRET);
    if (header) expect(output).not.toContain(header);
  });
  it.each(Object.keys(settings))('ausência de %s desabilita somente POC', (key) => {
    const client = new MercadoPagoClient(new ConfigService({ ...settings, [key]: '' }));
    expect(client.configured()).toBe(false);
    expect(() => client.assertConfigured()).toThrow('POC Mercado Pago não configurada');
  });
  it('email inválido é rejeitado na utilização', () => {
    expect(new MercadoPagoClient(new ConfigService({ ...settings, MERCADO_PAGO_POC_PAYER_EMAIL: 'invalid' })).configured()).toBe(false);
  });
  it('as três variáveis são opcionais e vazias no schema global', () => {
    for (const name of Object.keys(settings)) {
      expect(environmentValidationSchema.extract(name).validate(undefined).error).toBeUndefined();
      expect(environmentValidationSchema.extract(name).validate('').error).toBeUndefined();
    }
  });
  it('SDK envia Orders API com idempotência e separa criações concorrentes', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: externalId }), { status: 201 }));
    const client = new MercadoPagoClient(new ConfigService(settings));
    await Promise.all([client.create('10.00', 'poc-pix-a', 'a'), client.create('20.00', 'poc-pix-b', 'b')]);
    expect(spy.mock.calls.map(([url]) => url)).toEqual(['https://api.mercadopago.com/v1/orders', 'https://api.mercadopago.com/v1/orders']);
    expect(spy.mock.calls.map(([, options]) => new Headers(options?.headers).get('X-Idempotency-Key'))).toEqual(['a', 'b']);
  });
  it('não repete automaticamente erro HTTP externo', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { status: 500 }));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(new MercadoPagoClient(new ConfigService(settings)).get(externalId)).rejects.toThrow('Mercado Pago indisponível');
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('encerra espera em seis segundos mesmo se o SDK ficar pendente', async () => {
    jest.useFakeTimers();
    jest.spyOn(Order.prototype, 'get').mockImplementation(() => new Promise(() => undefined));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const result = new MercadoPagoClient(new ConfigService(settings)).get(externalId);
    const assertion = expect(result).rejects.toThrow('Mercado Pago indisponível');
    await jest.advanceTimersByTimeAsync(6000); await assertion;
  });
  it.each([
    ['created', 'created', 'PROCESSANDO'], ['processing', 'in_process', 'PROCESSANDO'],
    ['action_required', 'waiting_transfer', 'PENDENTE'], ['processed', 'accredited', 'APROVADO'],
    ['processed', 'partially_refunded', 'REEMBOLSADO_PARCIALMENTE'], ['canceled', 'canceled', 'CANCELADO'],
    ['expired', 'expired', 'EXPIRADO'], ['failed', 'failed', 'REJEITADO'], ['failed', 'processing_error', 'ERRO'],
    ['refunded', 'refunded', 'REEMBOLSADO'], ['charged_back', 'in_process', 'CONTESTADO'],
    ['unknown', '', 'ERRO'], ['processed', '', 'ERRO'],
    ['approved', '', 'APROVADO'], ['rejected', '', 'REJEITADO'], ['cancelled', '', 'CANCELADO'],
  ])('mapeia %s/%s para %s', (status, detail, expected) => expect(mapOrderStatus(status, detail)).toBe(expected));
});
