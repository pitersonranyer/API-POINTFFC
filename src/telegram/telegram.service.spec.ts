import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

describe('TelegramService', () => {
  const webhookSecret = 'test-webhook-secret';
  const botToken = '123456:test-bot-token';
  let fetchSpy: jest.SpyInstance;

  const createService = (values: Record<string, string | undefined> = {}) => {
    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    return new TelegramService(configService);
  };

  const privateMessage = (text: string, chatId: number | string = 12345) => ({
    message: {
      chat: { id: chatId, type: 'private' },
      text,
    },
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a missing webhook secret configuration', async () => {
    const service = createService({ TELEGRAM_BOT_TOKEN: botToken });

    await expect(service.handleWebhook(webhookSecret, privateMessage('/start'))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty webhook secret configuration', async () => {
    const service = createService({
      TELEGRAM_WEBHOOK_SECRET: '',
      TELEGRAM_BOT_TOKEN: botToken,
    });

    await expect(service.handleWebhook(webhookSecret, privateMessage('/start'))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing request secret', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret });

    await expect(service.handleWebhook(undefined, privateMessage('/start'))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid request secret', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret });

    await expect(service.handleWebhook('invalid-secret', privateMessage('/start'))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('responds to /start in a private chat in Portuguese', async () => {
    const service = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: botToken,
    });

    await service.handleWebhook(webhookSecret, privateMessage('/start'));

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/bot' + botToken + '/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('Bem-vindo ao POINT FFC Connect!'),
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('responds with the preparation message to an unknown text message', async () => {
    const service = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: botToken,
    });

    await service.handleWebhook(webhookSecret, privateMessage('Olá'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      text: string;
    };
    expect(requestBody.text).toContain('POINT FFC Connect está em preparação.');
    expect(requestBody.text).toContain('Envie /start');
  });

  it('ignores unsupported events, non-text updates, and group messages', async () => {
    const service = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: botToken,
    });

    await service.handleWebhook(webhookSecret, { callback_query: {} });
    await service.handleWebhook(webhookSecret, { message: { chat: { id: 1, type: 'private' } } });
    await service.handleWebhook(
      webhookSecret,
      { message: { chat: { id: -100, type: 'group' }, text: '/start' } },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('acknowledges the update without throwing when Telegram communication fails', async () => {
    const service = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: botToken,
    });
    fetchSpy.mockRejectedValue(new Error('failure'));

    await expect(service.handleWebhook(webhookSecret, privateMessage('/start'))).resolves.toBeUndefined();
  });

  it('does not call Telegram when the bot token is missing or empty', async () => {
    const missingTokenService = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret });
    const emptyTokenService = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: '',
    });

    await missingTokenService.handleWebhook(webhookSecret, privateMessage('/start'));
    await emptyTokenService.handleWebhook(webhookSecret, privateMessage('/start'));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
