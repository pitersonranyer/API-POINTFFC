import { BadGatewayException, ConflictException, Logger, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { MercadoPagoRecargaClient } from '../src/carteira/mercado-pago-recarga.client';
import { RecargaPixService } from '../src/carteira/recarga-pix.service';

describe('RecargaPixService', () => {
  let service: RecargaPixService;
  let prisma: any;
  let carteiras: any;
  let recargas: any;
  let client: any;
  let recarga: any;
  let order: any;
  const user = { idUsuario: 1, email: 'user@example.com' };
  const key = 'same-request-key-1234';
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    recarga = { id: 7, carteiraId: 2, valor: new Prisma.Decimal('10'), provedor: 'MERCADO_PAGO',
      externalReference: 'ref', idPagamentoExterno: 'ORD1', status: 'PENDENTE' };
    order = { id: 'ORD1', total_amount: '10.00', external_reference: 'ref', status: 'action_required',
      transactions: { payments: [{ payment_method: { id: 'pix', qr_code: 'copy-secret', qr_code_base64: 'qr-secret' } }] } };
    prisma = { recargaCarteira: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(recarga) } };
    carteiras = { obterOuCriar: jest.fn().mockResolvedValue({ id: 2, status: 'ATIVA' }),
      aplicarRecargaPix: jest.fn().mockImplementation(async (_id: number, data: any) => ({ ...recarga, ...data })) };
    recargas = { consultarPorExternalReference: jest.fn().mockResolvedValue(null),
      consultarPorIdPagamentoExterno: jest.fn().mockResolvedValue(recarga),
      criar: jest.fn().mockImplementation(async (data: any) => { recarga = { ...recarga, ...data, idPagamentoExterno: null, valor: new Prisma.Decimal(data.valor) }; return recarga; }) };
    client = { assertConfigured: jest.fn(), validateSignature: jest.fn(), get: jest.fn().mockImplementation(async () => order),
      create: jest.fn().mockImplementation(async (_valor: string, ref: string) => ({ ...order, external_reference: ref })) };
    service = new RecargaPixService(prisma, carteiras, recargas, client);
  });
  afterEach(() => jest.restoreAllMocks());

  const events = () => jest.mocked(console.error).mock.calls.map(([line]) => JSON.parse(line));

  it('valida HMAC com ID lowercase e preserva a Order original nas etapas seguintes', async () => {
    const dataId = 'ORD01M25RYSMJ2WFJBQYJV8PAW94Q';
    const settings = { MERCADO_PAGO_ACCESS_TOKEN: 'test-token', MERCADO_PAGO_WEBHOOK_SECRET: 'test-secret' };
    const signatureClient = new MercadoPagoRecargaClient(new ConfigService(settings));
    client.validateSignature.mockImplementation(signatureClient.validateSignature.bind(signatureClient));
    order.id = dataId;
    recarga.idPagamentoExterno = dataId;
    const ts = '1742505638683';
    const hash = createHmac('sha256', settings.MERCADO_PAGO_WEBHOOK_SECRET)
      .update(`id:ord01m25rysmj2wfjbqyjv8paw94q;request-id:req-1;ts:${ts};`).digest('hex');

    await expect(service.webhook(`ts=${ts},v1=${hash}`, 'req-1', dataId)).resolves.toEqual({ received: true });

    expect(client.get).toHaveBeenCalledWith(dataId);
    expect(recargas.consultarPorIdPagamentoExterno).toHaveBeenCalledWith(dataId);
    expect(carteiras.aplicarRecargaPix).toHaveBeenCalledWith(7, expect.objectContaining({ idPagamentoExterno: dataId }));
    expect(events().filter((event) => event.orderId).every((event) => event.orderId === dataId)).toBe(true);
    expect(events().some((event) => event.marker === 'WEBHOOK_CARTEIRA_ASSINATURA_OK')).toBe(true);
  });

  it('registra etapas do webhook em linhas JSON sem dados sensiveis', async () => {
    order.status = 'processed'; order.status_detail = 'accredited';
    order.payer = { email: 'sensitive@example.com' };
    await service.webhook('signature-secret', 'request-secret', 'ORD1');
    expect(events().map((event) => event.marker)).toEqual([
      'WEBHOOK_CARTEIRA_ORDER_ID', 'WEBHOOK_CARTEIRA_ASSINATURA_OK', 'WEBHOOK_CARTEIRA_ORDER_CONSULTADA',
      'WEBHOOK_CARTEIRA_STATUS', 'WEBHOOK_CARTEIRA_RECARGA_LOCALIZADA', 'WEBHOOK_CARTEIRA_PROCESSADA',
    ]);
    expect(events()[3]).toMatchObject({ orderId: 'ORD1', status: 'processed', status_detail: 'accredited' });
    expect(events()[5]).toMatchObject({ recargaId: 7, resultado: 'ok', status: 'APROVADA' });
    for (const args of jest.mocked(console.error).mock.calls) {
      expect(args).toHaveLength(1);
      expect(args[0]).not.toMatch(/[\r\n]|signature-secret|request-secret|copy-secret|qr-secret|sensitive@example.com/);
      expect(JSON.parse(args[0])).toMatchObject({ level: 'error', timestamp: expect.any(String) });
    }
  });

  it.each(['assinatura', 'consulta_order', 'localizacao_recarga', 'processamento_recarga'])('registra falha em %s sem mascarar erro', async (etapa) => {
    const error = etapa === 'assinatura' ? new UnauthorizedException('token-secret')
      : etapa === 'consulta_order' ? new BadGatewayException('pix-secret') : new Error('query qr-secret');
    if (etapa === 'assinatura') client.validateSignature.mockImplementation(() => { throw error; });
    if (etapa === 'consulta_order') client.get.mockRejectedValue(error);
    if (etapa === 'localizacao_recarga') recargas.consultarPorIdPagamentoExterno.mockRejectedValue(error);
    if (etapa === 'processamento_recarga') carteiras.aplicarRecargaPix.mockRejectedValue(error);
    const result = service.webhook('signature-secret', 'request-secret', 'ORD1');
    if (etapa === 'assinatura' || etapa === 'consulta_order') await expect(result).rejects.toBe(error);
    else await expect(result).rejects.toMatchObject({ status: 503 });
    expect(events().at(-1)).toMatchObject({ marker: 'WEBHOOK_CARTEIRA_ERRO', etapa,
      httpStatus: etapa === 'assinatura' ? 401 : etapa === 'consulta_order' ? 502 : 503 });
    expect(events().some((event) => event.marker === 'WEBHOOK_CARTEIRA_PROCESSADA')).toBe(false);
    if (etapa === 'assinatura') expect(events().some((event) => event.marker === 'WEBHOOK_CARTEIRA_ASSINATURA_OK')).toBe(false);
    expect(JSON.stringify(events())).not.toMatch(/token-secret|pix-secret|qr-secret|signature-secret|request-secret/);
  });

  it('omite ID invalido e status inesperado dos logs', async () => {
    client.validateSignature.mockImplementationOnce(() => { throw new UnauthorizedException(); });
    await expect(service.webhook('sig', 'req', 'sensitive@example.com')).rejects.toThrow();
    expect(JSON.stringify(events())).not.toContain('sensitive@example.com');
    jest.mocked(console.error).mockClear();
    order.status = 'sensitive@example.com'; order.status_detail = 'qr-secret';
    await service.webhook('sig', 'req', 'ORD1');
    expect(events().find((event) => event.marker === 'WEBHOOK_CARTEIRA_STATUS')).toMatchObject({ status: 'desconhecido', status_detail: 'desconhecido' });
    expect(JSON.stringify(events())).not.toMatch(/sensitive@example.com|qr-secret/);
  });

  it('persiste pendente antes de criar Order e vincula PIX', async () => {
    const result = await service.criar(user, '10.00', key);
    expect(recargas.criar).toHaveBeenCalledWith({ carteiraId: 2, valor: '10.00', provedor: 'MERCADO_PAGO', externalReference: expect.any(String) });
    expect(recargas.criar.mock.invocationCallOrder[0]).toBeLessThan(client.create.mock.invocationCallOrder[0]);
    expect(prisma.recargaCarteira.updateMany).toHaveBeenCalledWith({ where: { id: 7, idPagamentoExterno: null }, data: { idPagamentoExterno: 'ORD1' } });
    expect(result).toMatchObject({ valor: '10.00', status: 'PENDENTE', pixCopiaCola: 'copy-secret', qrCode: 'qr-secret' });
    expect(console.error).toHaveBeenCalledTimes(1);
    const args = jest.mocked(console.error).mock.calls[0];
    expect(args).toHaveLength(1);
    expect(args[0]).not.toMatch(/[\r\n]/);
    expect(JSON.parse(args[0])).toEqual({ marker: 'RECARGA_PIX_BEFORE_MP_CREATE', level: 'error',
      timestamp: expect.any(String), usuarioId: 1, recargaId: 7 });
    expect(Number.isFinite(Date.parse(JSON.parse(args[0]).timestamp))).toBe(true);
    expect(jest.mocked(console.error).mock.invocationCallOrder[0]).toBeLessThan(client.create.mock.invocationCallOrder[0]);
  });

  it('PIX já aprovado na criação usa o mesmo caminho de crédito', async () => {
    order.status = 'processed'; order.status_detail = 'accredited';
    expect(await service.criar(user, '10.00', key)).toMatchObject({ status: 'APROVADA' });
    expect(carteiras.aplicarRecargaPix).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'APROVADA' }));
  });

  it('retry da criação recupera recarga e mantém a mesma referência', async () => {
    client.create.mockRejectedValueOnce(new BadGatewayException('timeout'));
    await expect(service.criar(user, '10.00', key)).rejects.toThrow('timeout');
    recargas.consultarPorExternalReference.mockResolvedValue(recarga);
    await service.criar(user, '10.00', key);
    expect(recargas.criar).toHaveBeenCalledTimes(1);
    expect(client.create.mock.calls[0]).toEqual(client.create.mock.calls[1]);
  });

  it('rejeita reutilização da chave com outro valor', async () => {
    recargas.consultarPorExternalReference.mockResolvedValue(recarga);
    await expect(service.criar(user, '11.00', key)).rejects.toThrow('Idempotency-Key já utilizada');
    expect(client.create).not.toHaveBeenCalled();
  });

  it('resolve criação concorrente da referência usando a recarga persistida', async () => {
    recargas.criar.mockRejectedValueOnce(new ConflictException('Referência já cadastrada'));
    recargas.consultarPorExternalReference.mockResolvedValueOnce(null).mockResolvedValueOnce(recarga);
    await service.criar(user, '10.00', key);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith('ORD1');
  });

  it('chave de idempotência é isolada por usuário', async () => {
    await service.criar(user, '10.00', key);
    await service.criar({ ...user, idUsuario: 9 }, '10.00', key);
    expect(recargas.criar.mock.calls[0][0].externalReference).not.toBe(recargas.criar.mock.calls[1][0].externalReference);
  });

  it.each([undefined, '', 'short', 'invalid key with spaces'])('rejeita chave inválida %s antes de persistir', async (invalidKey) => {
    await expect(service.criar(user, '10.00', invalidKey)).rejects.toThrow('Idempotency-Key');
    expect(recargas.criar).not.toHaveBeenCalled();
  });

  it('retry com Order já vinculada consulta a Order sem criar outra', async () => {
    recargas.consultarPorExternalReference.mockResolvedValue(recarga);
    await service.criar(user, '10.00', key);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith('ORD1');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('carteira bloqueada impede retry de criação ainda sem Order', async () => {
    carteiras.obterOuCriar.mockResolvedValue({ id: 2, status: 'BLOQUEADA' });
    recarga.idPagamentoExterno = null;
    recargas.consultarPorExternalReference.mockResolvedValue(recarga);
    await expect(service.criar(user, '10.00', key)).rejects.toThrow('Carteira bloqueada');
    expect(client.create).not.toHaveBeenCalled();
  });

  it('webhook pendente -> aprovado consulta Order oficial', async () => {
    await service.webhook('sig', 'request', 'ORD1');
    order.status = 'processed'; order.status_detail = 'accredited';
    await service.webhook('sig', 'request', 'ORD1');
    expect(client.validateSignature).toHaveBeenCalledWith('sig', 'request', 'ORD1');
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(carteiras.aplicarRecargaPix.mock.calls.map((c: any[]) => c[1].status)).toEqual(['PENDENTE', 'APROVADA']);
  });

  it('Order desconhecida retorna ACK sem criar recarga nem creditar', async () => {
    recargas.consultarPorIdPagamentoExterno.mockResolvedValue(null);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      expect(await service.webhook('sig', 'req', 'ORD1')).toEqual({ received: true });
      expect(recargas.criar).not.toHaveBeenCalled();
      expect(carteiras.aplicarRecargaPix).not.toHaveBeenCalled();
      expect(events().at(-1)).toMatchObject({ marker: 'WEBHOOK_CARTEIRA_PROCESSADA', resultado: 'ignorada_sem_recarga' });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ORD1' }));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/copy-secret|qr-secret/);
    } finally { log.mockRestore(); }
  });

  it('assinatura inválida impede consulta e crédito', async () => {
    client.validateSignature.mockImplementation(() => { throw new UnauthorizedException('Assinatura inválida'); });
    await expect(service.webhook('bad', 'req', 'ORD1')).rejects.toThrow('Assinatura inválida');
    expect(client.get).not.toHaveBeenCalled(); expect(carteiras.aplicarRecargaPix).not.toHaveBeenCalled();
  });

  it('Order.get com erro permite retry sem atualizar banco', async () => {
    client.get.mockRejectedValue(new BadGatewayException('Order indisponível'));
    await expect(service.webhook('sig', 'req', 'ORD1')).rejects.toThrow('Order indisponível');
    expect(carteiras.aplicarRecargaPix).not.toHaveBeenCalled();
  });

  it.each([{ id: 'ORDOTHER' }, { total_amount: '11.00' }, { external_reference: 'another' }])('rejeita Order inconsistente %j', async (change) => {
    Object.assign(order, change);
    await expect(service.webhook('sig', 'req', 'ORD1')).rejects.toThrow();
    expect(carteiras.aplicarRecargaPix).not.toHaveBeenCalled();
  });

  it('rejeita provedor incompatível', async () => {
    recarga.provedor = 'OUTRO';
    await expect(service.webhook('sig', 'req', 'ORD1')).rejects.toThrow('Order incompatível');
  });

  it('consulta limita recarga ao usuário autenticado', async () => {
    prisma.recargaCarteira.findFirst.mockResolvedValue(null);
    await expect(service.consultar(99, 7)).rejects.toThrow('Recarga não encontrada');
    expect(prisma.recargaCarteira.findFirst).toHaveBeenCalledWith({ where: { id: 7, carteira: { usuarioId: 99 }, provedor: 'MERCADO_PAGO' } });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('erro de banco é recuperável e não expõe dados da consulta', async () => {
    recargas.consultarPorIdPagamentoExterno.mockRejectedValue(new Error('query com qr-secret'));
    await expect(service.webhook('sig', 'req', 'ORD1')).rejects.toThrow('Falha ao processar recarga');
  });
});
