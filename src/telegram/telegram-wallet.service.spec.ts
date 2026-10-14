import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CarteiraService } from '../carteira/carteira.service';
import { RecargaPixService } from '../carteira/recarga-pix.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramWalletService } from './telegram-wallet.service';

describe('TelegramWalletService', () => {
  const pendingRequest = (): { id: string; telegramUserId: string; usuarioId: number; idempotencyKey: string; valor: Prisma.Decimal;
    expiraEm: Date; confirmadoEm: Date | null; recargaId: number | null; criadoEm: Date; atualizadoEm: Date; recarga: null } => ({
    id: 'request-persisted', telegramUserId: '54321', usuarioId: 7, idempotencyKey: 'persisted-idempotency-key',
    valor: new Prisma.Decimal('25.00'), expiraEm: new Date(Date.now() + 600000), confirmadoEm: new Date(),
    recargaId: null, criadoEm: new Date(), atualizadoEm: new Date(), recarga: null,
  });

  let request: ReturnType<typeof pendingRequest>;
  let prisma: { telegramWalletRequest: Record<string, jest.Mock>; telegramAccountLink: { findUnique: jest.Mock }; $transaction: jest.Mock; $queryRaw: jest.Mock };
  let links: { resolveActiveUser: jest.Mock };
  let wallets: { obterOuCriar: jest.Mock };
  let pix: { criarParaTelegram: jest.Mock; consultarStatusTelegram: jest.Mock };
  let service: TelegramWalletService;

  const createService = () => new TelegramWalletService(
    prisma as unknown as PrismaService,
    links as unknown as TelegramLinkService,
    wallets as unknown as CarteiraService,
    pix as unknown as RecargaPixService,
  );

  beforeEach(() => {
    request = pendingRequest();
    prisma = { telegramWalletRequest: {
      findFirst: jest.fn().mockImplementation(async () => ({ ...request })),
      findUnique: jest.fn().mockImplementation(async () => ({ ...request })),
      updateMany: jest.fn().mockImplementation(async ({ data }: { data: Partial<typeof request> }) => {
        Object.assign(request, data);
        return { count: 1 };
      }),
      create: jest.fn(),
    },
    telegramAccountLink: { findUnique: jest.fn().mockResolvedValue({ usuarioId: 7, usuario: { status: 'ATIVO' } }) },
    $transaction: jest.fn().mockImplementation((callback: (tx: unknown) => unknown) => callback(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([{ id_usuario: 7 }]),
    };
    links = { resolveActiveUser: jest.fn().mockResolvedValue({ idUsuario: 7, email: 'private@example.test' }) };
    wallets = { obterOuCriar: jest.fn().mockResolvedValue({ saldoDisponivel: new Prisma.Decimal('12.50'), saldoBloqueado: new Prisma.Decimal('3.00'), status: 'ATIVA' }) };
    pix = {
      criarParaTelegram: jest.fn().mockResolvedValue({ id: 91, valor: '25.00', status: 'PENDENTE', idPagamentoExterno: 'mp-91', pixCopiaCola: 'pix-copy', qrCode: 'aGVsbG8=', expiracao: new Date(Date.now() + 3600000) }),
      consultarStatusTelegram: jest.fn().mockResolvedValue({ id: 91, valor: '25.00', status: 'APROVADA', idPagamentoExterno: 'mp-91', pixCopiaCola: 'pix-copy', qrCode: 'aGVsbG8=', expiracao: null }),
    };
    service = createService();
  });

  it('rejects users without an active Telegram link and never exposes an email in the error', async () => {
    links.resolveActiveUser.mockResolvedValue(null);
    await expect(service.consultar('54321')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(wallets.obterOuCriar).not.toHaveBeenCalled();
  });

  it('returns available and blocked balances without exposing email', async () => {
    const snapshot = await service.consultar('54321');
    expect(snapshot).toMatchObject({ saldoDisponivel: '12.50', saldoBloqueado: '3.00', status: 'ATIVA' });
    expect(JSON.stringify(snapshot)).not.toContain('private@example.test');
  });

  it('reuses the persistent idempotency key after service recreation and does not create a second operation', async () => {
    const firstInstance = createService();
    const first = await firstInstance.atualizar('54321', 'request-persisted');
    const restartedInstance = createService();
    const recovered = await restartedInstance.atualizar('54321', 'request-persisted');
    expect(first.status).toBe('PENDENTE');
    expect(recovered.status).toBe('APROVADA');
    expect(pix.criarParaTelegram).toHaveBeenCalledTimes(1);
    expect(pix.consultarStatusTelegram).toHaveBeenCalledWith(7, 91);
    expect(pix.criarParaTelegram).toHaveBeenNthCalledWith(1, { idUsuario: 7, email: 'private@example.test' }, '25.00', 'persisted-idempotency-key');
    expect(prisma.telegramWalletRequest.create).not.toHaveBeenCalled();
  });

  it('refreshes an existing PIX and reflects provider-confirmed status', async () => {
    request.recargaId = 91;
    const payment = await service.atualizar('54321', 'request-persisted');
    expect(pix.consultarStatusTelegram).toHaveBeenCalledWith(7, 91);
    expect(payment.status).toBe('APROVADA');
    expect(pix.criarParaTelegram).not.toHaveBeenCalled();
  });

  it('claims the explicit confirmation once, checks the active link and reuses one PIX idempotency key', async () => {
    await service.confirmar('54321', 'request-persisted');
    await service.confirmar('54321', 'request-persisted');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.telegramAccountLink.findUnique).toHaveBeenCalledTimes(2);
    expect(pix.criarParaTelegram).toHaveBeenCalledTimes(2);
    expect(pix.criarParaTelegram).toHaveBeenNthCalledWith(1, { idUsuario: 7, email: 'private@example.test' }, '25.00', 'persisted-idempotency-key');
    expect(pix.criarParaTelegram).toHaveBeenNthCalledWith(2, { idUsuario: 7, email: 'private@example.test' }, '25.00', 'persisted-idempotency-key');
  });

  it('propagates a safe provider failure while leaving the persistent key available for recovery', async () => {
    pix.criarParaTelegram.mockRejectedValueOnce(new Error('provider details must not be surfaced'));
    await expect(service.atualizar('54321', 'request-persisted')).rejects.toThrow('provider details must not be surfaced');
    expect(request.idempotencyKey).toBe('persisted-idempotency-key');
    const restartedService = createService();
    await restartedService.atualizar('54321', 'request-persisted');
    expect(pix.criarParaTelegram).toHaveBeenNthCalledWith(2, { idUsuario: 7, email: 'private@example.test' }, '25.00', 'persisted-idempotency-key');
  });
});
