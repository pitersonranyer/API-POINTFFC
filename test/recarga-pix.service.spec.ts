import { BadGatewayException, ConflictException, Logger, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

  it('persiste pendente antes de criar Order e vincula PIX', async () => {
    const result = await service.criar(user, '10.00', key);
    expect(recargas.criar).toHaveBeenCalledWith({ carteiraId: 2, valor: '10.00', provedor: 'MERCADO_PAGO', externalReference: expect.any(String) });
    expect(recargas.criar.mock.invocationCallOrder[0]).toBeLessThan(client.create.mock.invocationCallOrder[0]);
    expect(prisma.recargaCarteira.updateMany).toHaveBeenCalledWith({ where: { id: 7, idPagamentoExterno: null }, data: { idPagamentoExterno: 'ORD1' } });
    expect(result).toMatchObject({ valor: '10.00', status: 'PENDENTE', pixCopiaCola: 'copy-secret', qrCode: 'qr-secret' });
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
