import { TelegramPixNotificationService } from '../src/carteira/telegram-pix-notification.service';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { CarteiraService } from '../src/carteira/carteira.service';
import { RecargaCarteiraService } from '../src/carteira/recarga-carteira.service';
import { RecargaPixService } from '../src/carteira/recarga-pix.service';
import { MercadoPagoRecargaClient, RecargaOrder } from '../src/carteira/mercado-pago-recarga.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelegramLinkService } from '../src/telegram-link/telegram-link.service';
import { TelegramWalletService } from '../src/telegram/telegram-wallet.service';

// Banco MySQL dedicado, com migrations até 0023 já aplicadas pelo operador.
// Este teste não executa migrations e nunca usa DATABASE_URL implicitamente.
const databaseUrl = process.env.CARTEIRA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('PIX persistente - atomicidade e concorrência MySQL', () => {
  const prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  const carteiras = new CarteiraService(prisma as PrismaService);
  const recargas = new RecargaCarteiraService(prisma as PrismaService);
  const links = new TelegramLinkService(prisma as PrismaService);
  const client = { assertConfigured: jest.fn(), validateSignature: jest.fn(), get: jest.fn(), create: jest.fn() };
  const notificacoes = { enviar: jest.fn() };
  const service = new RecargaPixService(prisma as PrismaService, carteiras, recargas, client as unknown as MercadoPagoRecargaClient, notificacoes as unknown as TelegramPixNotificationService);
  const telegramService = new TelegramWalletService(prisma as PrismaService, links, carteiras, service);
  let usuario: { idUsuario: number; email: string };
  let carteiraId: number;
  let order: RecargaOrder;
  beforeAll(() => prisma.$connect());
  beforeEach(async () => {
    notificacoes.enviar.mockReset();
    usuario = await prisma.usuario.create({ data: { email: `pix-${randomUUID()}@example.invalid` } });
    carteiraId = (await carteiras.obterOuCriar(usuario.idUsuario)).id;
    order = { id: `ORD${randomUUID().replace(/-/g, '').toUpperCase()}`, total_amount: '7.25', status: 'processed', status_detail: 'accredited' } as RecargaOrder;
    client.get.mockImplementation(async () => order);
    client.create.mockImplementation(async (_valor: string, ref: string) => { order.external_reference = ref; return order; });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.$transaction(async (tx) => {
      await tx.telegramWalletRequest.deleteMany({ where: { usuarioId: usuario.idUsuario } });
      await tx.telegramAccountLink.deleteMany({ where: { usuarioId: usuario.idUsuario } });
      await tx.movimentacaoCarteira.deleteMany({ where: { carteiraId } });
      await tx.recargaCarteira.deleteMany({ where: { carteiraId } });
      await tx.carteira.delete({ where: { id: carteiraId } });
      await tx.usuario.delete({ where: { idUsuario: usuario.idUsuario } });
    });
  });
  afterAll(() => prisma.$disconnect());

  async function pendente() {
    const recarga = await recargas.criar({ carteiraId, valor: '7.25', provedor: 'MERCADO_PAGO', idPagamentoExterno: order.id });
    order.external_reference = recarga.externalReference;
    return recarga;
  }
  const webhook = () => service.webhook('sig', 'req', order.id);

  it('criação aprovada e retry persistem uma única Order vinculada e um crédito', async () => {
    const key = randomUUID();
    const a = await service.criar(usuario, '7.25', key);
    const b = await service.criar(usuario, '7.25', key);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('APROVADA');
    expect(await prisma.recargaCarteira.count({ where: { carteiraId } })).toBe(1);
    expect(await prisma.movimentacaoCarteira.count({ where: { carteiraId } })).toBe(1);
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('7.25');
  });

  it('webhooks duplicados geram uma movimentação com saldos corretos', async () => {
    const recarga = await pendente();
    await carteiras.creditar({ usuarioId: usuario.idUsuario, valor: '10', origem: 'AJUSTE' });
    await webhook(); await webhook();
    const movimentos = await prisma.movimentacaoCarteira.findMany({ where: { recargaId: recarga.id } });
    expect(movimentos).toHaveLength(1);
    expect(movimentos[0].saldoAnterior.toString()).toBe('10');
    expect(movimentos[0].saldoPosterior.toString()).toBe('17.25');
    expect(movimentos[0].referenciaId).toBe(String(recarga.id));
    const { id: _id, ...duplicate } = movimentos[0];
    expect(_id).toBeGreaterThan(0);
    await expect(prisma.movimentacaoCarteira.create({ data: duplicate })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('dois webhooks simultâneos da mesma Order creditam uma única vez', async () => {
    const recarga = await pendente();
    await Promise.all([webhook(), webhook()]);
    expect(await prisma.movimentacaoCarteira.count({ where: { recargaId: recarga.id } })).toBe(1);
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('7.25');
    expect(notificacoes.enviar).toHaveBeenCalledTimes(1);
  });

  it('dois POSTs com a mesma chave reutilizam recarga e crédito', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([service.criar(usuario, '7.25', key), service.criar(usuario, '7.25', key)]);
    expect(a.id).toBe(b.id);
    expect(await prisma.recargaCarteira.count({ where: { carteiraId } })).toBe(1);
    expect(await prisma.movimentacaoCarteira.count({ where: { carteiraId } })).toBe(1);
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('7.25');
  });

  it('migration 0023 está aplicada com colunas e índices únicos da solicitação Telegram', async () => {
    const columns = await prisma.$queryRaw<{ Field: string }[]>`SHOW COLUMNS FROM TELEGRAM_WALLET_REQUEST`;
    const indexes = await prisma.$queryRaw<{ Key_name: string; Non_unique: number | bigint }[]>`SHOW INDEX FROM TELEGRAM_WALLET_REQUEST`;
    expect(columns.map((column) => column.Field)).toEqual(expect.arrayContaining([
      'id', 'telegram_user_id', 'usuario_id', 'idempotency_key', 'valor', 'expira_em', 'confirmado_em', 'recarga_id',
    ]));
    expect(indexes.map((index) => ({ ...index, Non_unique: Number(index.Non_unique) }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ Key_name: 'TELEGRAM_WALLET_REQUEST_idempotency_key_key', Non_unique: 0 }),
      expect.objectContaining({ Key_name: 'TELEGRAM_WALLET_REQUEST_recarga_id_key', Non_unique: 0 }),
      expect.objectContaining({ Key_name: 'TG_WALLET_REQUEST_TELEGRAM_USUARIO_CRIADO_idx', Non_unique: 1 }),
      expect.objectContaining({ Key_name: 'TG_WALLET_REQUEST_USUARIO_CONFIRMADO_EXPIRA_idx', Non_unique: 1 }),
    ]));
  });

  it('confirmações Telegram simultâneas reutilizam a recarga persistida e não creditam antes do webhook', async () => {
    const telegramUserId = `tg-${randomUUID()}`.slice(0, 32);
    await prisma.telegramAccountLink.create({ data: { telegramUserId, usuarioId: usuario.idUsuario } });
    const request = await telegramService.preparar(telegramUserId, '7.25');

    const [first, second] = await Promise.all([
      telegramService.confirmar(telegramUserId, request.id),
      telegramService.confirmar(telegramUserId, request.id),
    ]);

    expect(first.id).toBe(second.id);
    const createsAfterConfirmation = client.create.mock.calls.length;
    const repeated = await telegramService.confirmar(telegramUserId, request.id);
    expect(repeated.id).toBe(first.id);
    expect(client.create).toHaveBeenCalledTimes(createsAfterConfirmation);
    expect(await prisma.telegramWalletRequest.count({ where: { id: request.id, confirmadoEm: { not: null }, recargaId: first.id } })).toBe(1);
    expect(await prisma.recargaCarteira.count({ where: { carteiraId } })).toBe(1);
    expect(await prisma.movimentacaoCarteira.count({ where: { carteiraId } })).toBe(0);
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('0');
    expect(notificacoes.enviar).not.toHaveBeenCalled();
    await Promise.all([webhook(), webhook()]);
    expect(notificacoes.enviar).toHaveBeenCalledTimes(1);
    expect(await prisma.movimentacaoCarteira.count({ where: { carteiraId } })).toBe(1);
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('7.25');
  });

  it('falha na notificação não reverte crédito nem provoca retry no webhook duplicado', async () => {
    await pendente();
    notificacoes.enviar.mockRejectedValue(new Error('Telegram indisponível'));
    await expect(webhook()).resolves.toEqual({ received: true });
    await expect(webhook()).resolves.toEqual({ received: true });
    expect(notificacoes.enviar).toHaveBeenCalledTimes(1);
    expect(await prisma.movimentacaoCarteira.count({ where: { carteiraId } })).toBe(1);
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('7.25');
  });

  it('falha após saldo, movimentação e aprovação reverte tudo antes do commit', async () => {
    const recarga = await pendente();
    const transaction = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      transaction(async (tx) => { await callback(tx); throw new Error('Falha antes do commit'); })) as unknown as typeof prisma.$transaction);
    try { await expect(webhook()).rejects.toThrow('Falha ao processar recarga'); } finally { spy.mockRestore(); }
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('0');
    expect(await prisma.movimentacaoCarteira.count({ where: { recargaId: recarga.id } })).toBe(0);
    expect(await recargas.consultarPorId(recarga.id)).toMatchObject({ status: 'PENDENTE', aprovadoEm: null });
  });

  it('recargas diferentes na mesma carteira não perdem atualização de saldo', async () => {
    const a = await pendente();
    const b = await recargas.criar({ carteiraId, valor: '7.25', provedor: 'MERCADO_PAGO', idPagamentoExterno: `${order.id}B` });
    const oficial = { idPagamentoExterno: order.id!, externalReference: a.externalReference, valor: a.valor, status: 'APROVADA' as const };
    await Promise.all([carteiras.aplicarRecargaPix(a.id, oficial), carteiras.aplicarRecargaPix(b.id,
      { ...oficial, idPagamentoExterno: b.idPagamentoExterno!, externalReference: b.externalReference })]);
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('14.5');
  });

  it('falha no insert da movimentação reverte saldo e aprovação e permite retry', async () => {
    const recarga = await pendente();
    const transaction = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      transaction(async (tx) => callback(new Proxy(tx, { get(target, prop) {
        if (prop === 'movimentacaoCarteira') return new Proxy(tx.movimentacaoCarteira, { get(delegate, method) {
          if (method === 'create') return () => { throw new Error('Falha injetada após update de saldo'); };
          return Reflect.get(delegate, method);
        } });
        return Reflect.get(target, prop);
      } })))) as typeof prisma.$transaction);
    try { await expect(webhook()).rejects.toThrow('Falha ao processar recarga'); } finally { spy.mockRestore(); }
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('0');
    expect(await prisma.movimentacaoCarteira.count({ where: { recargaId: recarga.id } })).toBe(0);
    expect(await recargas.consultarPorId(recarga.id)).toMatchObject({ status: 'PENDENTE', aprovadoEm: null });
    await webhook();
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('7.25');
  });

  it.each(['rejected', 'expired'])('Order %s não altera saldo', async (status) => {
    await pendente(); order.status = status;
    await webhook();
    expect((await carteiras.obterOuCriar(usuario.idUsuario)).saldoDisponivel.toString()).toBe('0');
    expect(await prisma.movimentacaoCarteira.count({ where: { carteiraId } })).toBe(0);
  });
});
