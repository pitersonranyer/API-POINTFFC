import { TelegramPixNotificationService } from './telegram-pix-notification.service';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { CarteiraService } from './carteira.service';
import { RecargaCarteiraService } from './recarga-carteira.service';
import { RecargaPixService } from './recarga-pix.service';
import { MercadoPagoRecargaClient } from './mercado-pago-recarga.client';
import { PrismaService } from '../prisma/prisma.service';

describe('RecargaPixService Telegram-only operations', () => {
  const idempotencyKey = 'telegram-persistent-key-001';
  const externalReference = createHash('sha256').update(`7:${idempotencyKey}`).digest('hex');
  let recarga: Record<string, unknown>;
  let prisma: { recargaCarteira: Record<string, jest.Mock> };
  let carteira: { obterOuCriar: jest.Mock; aplicarRecargaPixComResultado: jest.Mock };
  let recargas: { consultarPorExternalReference: jest.Mock; criar: jest.Mock };
  let client: { assertConfigured: jest.Mock; create: jest.Mock; get: jest.Mock };
  let service: RecargaPixService;

  const order = (status: string) => ({
    id: 'ORD123', external_reference: externalReference, total_amount: '25.00', status, status_detail: 'accredited',
    transactions: { payments: [{ payment_method: { id: 'pix', qr_code: 'pix-copy', qr_code_base64: 'aGVsbG8=', date_of_expiration: '2026-10-15T12:00:00.000Z' } }] },
  });

  beforeEach(() => {
    recarga = {
      id: 91, carteiraId: 3, provedor: 'MERCADO_PAGO', externalReference, idPagamentoExterno: null,
      valor: new Prisma.Decimal('25.00'), status: 'PENDENTE', pixCopiaCola: null, qrCode: null,
      expiracao: null, criadoEm: new Date(), atualizadoEm: new Date(), aprovadoEm: null,
    };
    prisma = { recargaCarteira: {
      updateMany: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(recarga, data); return { count: 1 }; }),
      findUnique: jest.fn().mockImplementation(async () => ({ ...recarga })),
      findFirst: jest.fn().mockImplementation(async () => ({ ...recarga })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(recarga, data); return { ...recarga }; }),
    } };
    carteira = {
      obterOuCriar: jest.fn().mockResolvedValue({ id: 3, status: 'ATIVA' }),
      aplicarRecargaPixComResultado: jest.fn(),
    };
    recargas = {
      consultarPorExternalReference: jest.fn().mockResolvedValue({ ...recarga }),
      criar: jest.fn(),
    };
    client = {
      assertConfigured: jest.fn(),
      create: jest.fn().mockResolvedValue(order('approved')),
      get: jest.fn().mockResolvedValue(order('approved')),
    };
    service = new RecargaPixService(
      prisma as unknown as PrismaService,
      carteira as unknown as CarteiraService,
      recargas as unknown as RecargaCarteiraService,
      client as unknown as MercadoPagoRecargaClient,
      { enviar: jest.fn() } as unknown as TelegramPixNotificationService,
    );
  });

  it('recovers/creates PIX using persistent idempotency without applying wallet credit', async () => {
    const result = await service.criarParaTelegram({ idUsuario: 7, email: 'private@example.test' }, '25.00', idempotencyKey);
    expect(client.create).toHaveBeenCalledWith('25.00', externalReference, 'private@example.test');
    expect(prisma.recargaCarteira.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idPagamentoExterno: 'ORD123', pixCopiaCola: 'pix-copy', qrCode: 'aGVsbG8=' }),
    }));
    expect(result.status).toBe('PENDENTE');
    expect(result.pixCopiaCola).toBe('pix-copy');
    expect(carteira.aplicarRecargaPixComResultado).not.toHaveBeenCalled();
  });

  it('queries the provider status without applying credit; the webhook remains the credit path', async () => {
    recarga.idPagamentoExterno = 'ORD123';
    const result = await service.consultarStatusTelegram(7, 91);
    expect(client.get).toHaveBeenCalledWith('ORD123');
    expect(result.status).toBe('APROVADA');
    expect(recarga.status).toBe('PENDENTE');
    expect(carteira.aplicarRecargaPixComResultado).not.toHaveBeenCalled();
  });

  it('reuses the linked Order on repeated confirmation without creating another charge or credit', async () => {
    recargas.consultarPorExternalReference.mockImplementation(async () => ({ ...recarga }));
    const usuario = { idUsuario: 7, email: 'private@example.test' };

    const first = await service.criarParaTelegram(usuario, '25.00', idempotencyKey);
    const repeated = await service.criarParaTelegram(usuario, '25.00', idempotencyKey);

    expect(repeated.id).toBe(first.id);
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('ORD123');
    expect(recargas.criar).not.toHaveBeenCalled();
    expect(carteira.aplicarRecargaPixComResultado).not.toHaveBeenCalled();
  });
});
