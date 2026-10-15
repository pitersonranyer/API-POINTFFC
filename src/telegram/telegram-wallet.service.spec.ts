import { ConflictException, UnauthorizedException } from '@nestjs/common';
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
  let wallets: { obterOuCriar: jest.Mock; creditar: jest.Mock; debitar: jest.Mock; aplicarRecargaPix: jest.Mock };
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
      updateMany: jest.fn().mockImplementation(async ({ where, data }: {
        where: { confirmadoEm?: null; expiraEm?: { gt: Date } };
        data: Partial<typeof request>;
      }) => {
        if (where.confirmadoEm === null && request.confirmadoEm !== null) return { count: 0 };
        if (where.expiraEm && request.expiraEm <= where.expiraEm.gt) return { count: 0 };
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
    wallets = {
      obterOuCriar: jest.fn().mockResolvedValue({ saldoDisponivel: new Prisma.Decimal('12.50'), saldoBloqueado: new Prisma.Decimal('3.00'), status: 'ATIVA' }),
      creditar: jest.fn(), debitar: jest.fn(), aplicarRecargaPix: jest.fn(),
    };
    pix = {
      criarParaTelegram: jest.fn().mockResolvedValue({ id: 91, valor: '25.00', status: 'PENDENTE', idPagamentoExterno: 'mp-91', pixCopiaCola: 'pix-copy', qrCode: 'aGVsbG8=', expiracao: new Date(Date.now() + 3600000) }),
      consultarStatusTelegram: jest.fn().mockResolvedValue({ id: 91, valor: '25.00', status: 'APROVADA', idPagamentoExterno: 'mp-91', pixCopiaCola: 'pix-copy', qrCode: 'aGVsbG8=', expiracao: null }),
    };
    service = createService();
  });

  afterEach(() => jest.useRealTimers());

  it('confirms an unconfirmed valid request before generating PIX', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T12:00:00Z'));
    request.confirmadoEm = null;
    request.expiraEm = new Date(Date.now() + 1);

    await expect(service.confirmar('54321', request.id)).resolves.toMatchObject({ id: 91 });

    expect(request.confirmadoEm).toEqual(new Date());
    expect(prisma.telegramWalletRequest.updateMany).toHaveBeenCalledWith({
      where: { id: request.id, telegramUserId: '54321', usuarioId: 7, confirmadoEm: null, expiraEm: { gt: new Date() } },
      data: { confirmadoEm: new Date() },
    });
    expect(prisma.telegramWalletRequest.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(pix.criarParaTelegram.mock.invocationCallOrder[0]);
    expect(pix.criarParaTelegram).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 0])('rejects an unconfirmed request expiring at now %d ms without PIX or wallet changes', async (offset) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T12:00:00Z'));
    request.confirmadoEm = null;
    request.expiraEm = new Date(Date.now() + offset);
    const original = { ...request };

    await expect(service.confirmar('54321', request.id)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.telegramWalletRequest.updateMany).toHaveBeenCalledWith({
      where: { id: request.id, telegramUserId: '54321', usuarioId: 7, confirmadoEm: null, expiraEm: { gt: new Date() } },
      data: { confirmadoEm: new Date() },
    });
    expect(request).toEqual(original);
    expect(prisma.telegramWalletRequest.create).not.toHaveBeenCalled();
    expect(pix.criarParaTelegram).not.toHaveBeenCalled();
    expect(pix.consultarStatusTelegram).not.toHaveBeenCalled();
    expect(wallets.obterOuCriar).not.toHaveBeenCalled();
    expect(wallets.creditar).not.toHaveBeenCalled();
    expect(wallets.debitar).not.toHaveBeenCalled();
    expect(wallets.aplicarRecargaPix).not.toHaveBeenCalled();
  });

  it('retries an already confirmed request after its confirmation deadline using the same charge key', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T12:00:00Z'));
    request.confirmadoEm = null;
    request.expiraEm = new Date(Date.now() + 1);
    const first = await service.confirmar('54321', request.id);
    jest.advanceTimersByTime(2);
    const repeated = await service.confirmar('54321', request.id);

    expect(repeated.id).toBe(first.id);
    expect(pix.criarParaTelegram.mock.calls).toEqual([
      [{ idUsuario: 7, email: 'private@example.test' }, '25.00', request.idempotencyKey],
      [{ idUsuario: 7, email: 'private@example.test' }, '25.00', request.idempotencyKey],
    ]);
    expect(prisma.telegramWalletRequest.updateMany.mock.calls.filter(([args]) => args.data.confirmadoEm)).toHaveLength(1);
    expect(prisma.telegramWalletRequest.create).not.toHaveBeenCalled();
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
