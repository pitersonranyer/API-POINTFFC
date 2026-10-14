import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

describe('TelegramService', () => {
  const webhookSecret = 'test-webhook-secret';
  const botToken = '123456:test-bot-token';
  const competitions = [{ id: 42, nome: 'POINT FFC - Rodada 27', slug: 'rodada-27', tipoAcesso: 'FREE',
    valorInscricao: 0, rodadaInicio: 27, rodadaFim: 27, fimInscricao: '2026-10-14T23:59:00.000Z' }];
  let fetchSpy: jest.SpyInstance;
  let competitionsService: { listarDivulgaveis: jest.Mock };

  const createService = (values: Record<string, string | undefined> = {}) => {
    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    return new TelegramService(configService, competitionsService as never);
  };

  const privateMessage = (text: string, chatId: number | string = 12345) => ({
    message: {
      chat: { id: chatId, type: 'private' },
      text,
    },
  });

  beforeEach(() => {
    competitionsService = { listarDivulgaveis: jest.fn().mockResolvedValue(competitions) };
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as Response);
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
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as { reply_markup: { keyboard: { text: string }[][] } };
    expect(requestBody.reply_markup.keyboard[0][0].text).toBe('🏆 Ver competições');
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
    expect(requestBody.text).toContain('Use o botão abaixo');
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

  it('lists eligible competitions from the existing public service when the menu button is selected', async () => {
    const service = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: botToken,
    });

    await service.handleWebhook(webhookSecret, {
      update_id: 81,
      ...privateMessage('🏆 Ver competições'),
    });

    expect(competitionsService.listarDivulgaveis).toHaveBeenCalledWith();
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as { text: string };
    expect(requestBody.text).toContain('POINT FFC - Rodada 27');
    expect(requestBody.text).toContain('Rodada: 27');
    expect(requestBody.text).toContain('Valor: Grátis');
    expect(requestBody.text).toContain('https://pointffc.com.br/competicoes?id=42');
  });

  it('shows the empty state and catches public competition lookup errors', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    competitionsService.listarDivulgaveis.mockResolvedValueOnce([]);
    await service.handleWebhook(webhookSecret, { update_id: 82, ...privateMessage('🏆 Ver competições') });
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).text).toContain('não há competições abertas');

    fetchSpy.mockClear();
    competitionsService.listarDivulgaveis.mockRejectedValueOnce(new Error('internal diagnostic'));
    await expect(service.handleWebhook(webhookSecret, { update_id: 83, ...privateMessage('🏆 Ver competições') })).resolves.toBeUndefined();
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).text).toContain('Não foi possível consultar');
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain('internal diagnostic');
  });

  it('acknowledges a repeated update without sending duplicate messages', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    const update = { update_id: 84, ...privateMessage('/start') };
    await service.handleWebhook(webhookSecret, update);
    await service.handleWebhook(webhookSecret, update);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('splits long competition lists into Telegram-sized messages', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    competitionsService.listarDivulgaveis.mockResolvedValueOnce(Array.from({ length: 90 }, (_, index) => ({
      ...competitions[0], id: index + 1, nome: `Competição ${index + 1} ${'Nome '.repeat(30)}`,
    })));
    await service.handleWebhook(webhookSecret, { update_id: 85, ...privateMessage('🏆 Ver competições') });
    const texts = fetchSpy.mock.calls.map(call => JSON.parse(call[1]?.body as string).text as string);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every(text => text.length <= 4096)).toBe(true);
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
