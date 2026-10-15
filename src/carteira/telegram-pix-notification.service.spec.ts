import { ConfigService } from '@nestjs/config';
import { Prisma, RecargaCarteira } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramPixNotificationService } from './telegram-pix-notification.service';

describe('TelegramPixNotificationService', () => {
  const recarga = { id: 91, carteiraId: 3, valor: new Prisma.Decimal('25.10') } as RecargaCarteira;
  let request: { telegramUserId: string; confirmadoEm: Date | null; usuario: { status: string; carteira: { id: number }; telegramLink: { telegramUserId: string } | null } };
  let findUnique: jest.Mock;
  let fetchSpy: jest.SpyInstance;
  let service: TelegramPixNotificationService;

  beforeEach(() => {
    request = { telegramUserId: '54321', confirmadoEm: new Date(), usuario: { status: 'ATIVO', carteira: { id: 3 }, telegramLink: { telegramUserId: '54321' } } };
    findUnique = jest.fn().mockImplementation(async () => request);
    service = new TelegramPixNotificationService(
      { telegramWalletRequest: { findUnique } } as unknown as PrismaService,
      new ConfigService({ TELEGRAM_BOT_TOKEN: 'fake-test-token' }),
    );
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('sends the requested private message with decimal commas and a bold title', async () => {
    await service.enviar(recarga);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { recargaId: 91 } }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ chat_id: '54321',
      text: '✅ PIX confirmado!\n\n💰 Recarga de R$ 25,10 realizada com sucesso.\n\nO valor já está disponível na sua carteira POINT FFC.\n\n⚽ Boa sorte nas competições!',
      entities: [{ type: 'bold', offset: 0, length: '✅ PIX confirmado!'.length }],
    });
  });

  it('does not notify a site recharge with no Telegram wallet request', async () => {
    findUnique.mockResolvedValue(null);
    await service.enviar(recarga);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'unlinked', 'changed-link', 'wrong-wallet', 'group', 'unconfirmed'])('does not notify %s', async (state) => {
    if (state === 'inactive') request.usuario.status = 'INATIVO';
    if (state === 'unlinked') request.usuario.telegramLink = null;
    if (state === 'changed-link') request.usuario.telegramLink = { telegramUserId: '99999' };
    if (state === 'wrong-wallet') request.usuario.carteira.id = 99;
    if (state === 'group') request.telegramUserId = '-54321';
    if (state === 'unconfirmed') request.confirmadoEm = null;
    await service.enviar(recarga);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['network', 'http', 'api'])('makes only one attempt on %s failure', async (failure) => {
    if (failure === 'network') fetchSpy.mockRejectedValue(new Error('offline'));
    if (failure === 'http') fetchSpy.mockResolvedValue({ ok: false });
    if (failure === 'api') fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ ok: false }) });
    await expect(service.enviar(recarga)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts a hung Telegram request without retrying', async () => {
    jest.useFakeTimers();
    fetchSpy.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const sending = expect(service.enviar(recarga)).rejects.toThrow('aborted');
    await jest.advanceTimersByTimeAsync(5000);
    await sending;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not send when bot configuration is absent', async () => {
    service = new TelegramPixNotificationService({ telegramWalletRequest: { findUnique } } as unknown as PrismaService, new ConfigService({}));
    await expect(service.enviar(recarga)).rejects.toThrow('Telegram bot unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
