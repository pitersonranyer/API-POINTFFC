import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { TelegramLinkService } from './telegram-link.service';

describe('TelegramLinkService', () => {
  let prisma: {
    telegramLinkRequest: { create: jest.Mock; deleteMany: jest.Mock };
    telegramAccountLink: { findUnique: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    telegramLinkRequest: Record<string, jest.Mock>;
    telegramAccountLink: Record<string, jest.Mock>;
  };
  let service: TelegramLinkService;
  const request = {
    id: 5,
    telegramUserId: '777000111',
    codigoHash: createHash('sha256').update('c'.repeat(48)).digest('hex'),
    expiraEm: new Date(Date.now() + 60_000),
    usadoEm: null,
  };

  beforeEach(() => {
    tx = {
      telegramLinkRequest: {
        findUnique: jest.fn().mockResolvedValue(request),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      telegramAccountLink: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ criadoEm: new Date('2026-10-14T12:00:00.000Z') }),
      },
    };
    prisma = {
      telegramLinkRequest: {
        create: jest.fn().mockResolvedValue(undefined),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      telegramAccountLink: {
        findUnique: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    service = new TelegramLinkService(prisma as never);
  });

  it('persists only a SHA-256 hash for a cryptographically random short-lived request', async () => {
    const result = await service.createRequest('777000111');
    const persisted = prisma.telegramLinkRequest.create.mock.calls[0][0].data;
    expect(result.code).toMatch(/^[a-f0-9]{48}$/);
    expect(result.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(persisted.codigoHash).toBe(createHash('sha256').update(result.code).digest('hex'));
    expect(persisted.codigoHash).not.toBe(result.code);
    expect(persisted.telegramUserId).toBe('777000111');
  });

  it('confirms using only the authenticated internal user ID and consumes the request once', async () => {
    await expect(service.confirm(42, 'c'.repeat(48))).resolves.toEqual({
      linked: true,
      linkedAt: '2026-10-14T12:00:00.000Z',
    });
    expect(tx.telegramAccountLink.create).toHaveBeenCalledWith({
      data: { usuarioId: 42, telegramUserId: request.telegramUserId },
      select: { criadoEm: true },
    });
    expect(tx.telegramLinkRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: request.id, usadoEm: null, expiraEm: { gt: expect.any(Date) } },
    }));
  });

  it.each([
    ['unknown', null],
    ['already used', { ...request, usadoEm: new Date() }],
    ['expired', { ...request, expiraEm: new Date(Date.now() - 1) }],
  ])('rejects an %s confirmation without associating accounts', async (_case, row) => {
    tx.telegramLinkRequest.findUnique.mockResolvedValue(row);
    await expect(service.confirm(42, 'c'.repeat(48))).rejects.toThrow(BadRequestException);
    expect(tx.telegramAccountLink.create).not.toHaveBeenCalled();
  });

  it('does not consume a valid code when either account side already has a link', async () => {
    tx.telegramAccountLink.findFirst.mockResolvedValue({ id: 10 });
    await expect(service.confirm(42, 'c'.repeat(48))).rejects.toThrow(ConflictException);
    expect(tx.telegramLinkRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.telegramAccountLink.create).not.toHaveBeenCalled();
  });

  it('rejects a concurrent reuse when the conditional single-use claim loses', async () => {
    tx.telegramLinkRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.confirm(42, 'c'.repeat(48))).rejects.toThrow(BadRequestException);
    expect(tx.telegramAccountLink.create).not.toHaveBeenCalled();
  });

  it('maps a concurrent unique-index conflict to the same non-disclosing response', async () => {
    tx.telegramAccountLink.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      'unique constraint',
      { code: 'P2002', clientVersion: 'test' },
    ));
    await expect(service.confirm(42, 'c'.repeat(48))).rejects.toThrow(
      'Vínculo conflitante. Desconecte o vínculo atual antes de tentar novamente.',
    );
  });

  it('rate limits Telegram code issuance per sender', async () => {
    await service.createRequest('777000111');
    await service.createRequest('777000111');
    await service.createRequest('777000111');
    await expect(service.createRequest('777000111')).rejects.toMatchObject({
      status: 429,
    });
    expect(prisma.telegramLinkRequest.create).toHaveBeenCalledTimes(3);
  });

  it('returns only link state and disconnects the authenticated user link', async () => {
    prisma.telegramAccountLink.findUnique.mockResolvedValue({ criadoEm: new Date('2026-10-14T12:00:00Z') });
    await expect(service.status(42)).resolves.toEqual({ linked: true, linkedAt: '2026-10-14T12:00:00.000Z' });
    expect(prisma.telegramAccountLink.findUnique).toHaveBeenCalledWith({
      where: { usuarioId: 42 }, select: { criadoEm: true },
    });

    await expect(service.disconnect(42)).resolves.toEqual({ linked: false });
    expect(prisma.telegramAccountLink.deleteMany).toHaveBeenCalledWith({ where: { usuarioId: 42 } });
  });
});
