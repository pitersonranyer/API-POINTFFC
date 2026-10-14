import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramWebhookSyncService } from './telegram-webhook-sync.service';

describe('TelegramWebhookSyncService', () => {
  const botToken = 'test-bot-token';
  const webhookSecret = 'test-webhook-secret';
  const webhookUrl = 'https://api-pointffc.onrender.com/integracoes/telegram/webhook';
  let fetchSpy: jest.SpyInstance;
  let service: TelegramWebhookSyncService;
  let config: Record<string, string>;

  const apiResponse = (result: unknown, ok = true) => ({
    json: async () => ({ ok, result }),
  } as Response);

  const setConfig = (values: Record<string, string> = {}) => {
    config = { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: webhookSecret, ...values };
    service = new TelegramWebhookSyncService({ get: (key: string) => config[key] } as ConfigService);
  };

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockReset();
    setConfig();
  });

  afterEach(() => jest.restoreAllMocks());

  it('não chama setWebhook quando URL e eventos já estão corretos', async () => {
    fetchSpy.mockResolvedValueOnce(apiResponse({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }));

    await service.synchronize();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/getWebhookInfo');
  });

  it('trata lista vazia como configuração padrão e preserva os eventos ao corrigir a URL', async () => {
    fetchSpy
      .mockResolvedValueOnce(apiResponse({ url: webhookUrl, allowed_updates: [] }))
      .mockResolvedValueOnce(apiResponse({ url: 'https://old.example/webhook', allowed_updates: [] }))
      .mockResolvedValueOnce(apiResponse(true));

    await service.synchronize();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await service.synchronize();
    const payload = JSON.parse(String((fetchSpy.mock.calls[2][1] as RequestInit).body)) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('allowed_updates');
    expect(payload.secret_token).toBe(webhookSecret);
  });

  it('adiciona callback_query e preserva os demais eventos configurados', async () => {
    fetchSpy
      .mockResolvedValueOnce(apiResponse({ url: webhookUrl, allowed_updates: ['message', 'edited_message'] }))
      .mockResolvedValueOnce(apiResponse(true));

    await service.synchronize();

    const setRequest = fetchSpy.mock.calls[1][1] as RequestInit;
    const payload = JSON.parse(String(setRequest.body)) as Record<string, unknown>;
    expect(payload.allowed_updates).toEqual(['message', 'edited_message', 'callback_query']);
    expect(payload.secret_token).toBe(webhookSecret);
    expect(payload).not.toHaveProperty('drop_pending_updates');
  });

  it('corrige uma URL incorreta sem descartar atualizações pendentes', async () => {
    fetchSpy
      .mockResolvedValueOnce(apiResponse({ url: 'https://old.example/webhook', allowed_updates: ['message', 'callback_query'] }))
      .mockResolvedValueOnce(apiResponse(true));

    await service.synchronize();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body)) as Record<string, unknown>;
    expect(payload.url).toBe(webhookUrl);
    expect(payload.secret_token).toBe(webhookSecret);
    expect(payload).not.toHaveProperty('drop_pending_updates');
  });

  it('não rejeita quando a consulta ao Telegram falha', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network failure'));

    await expect(service.synchronize()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'])(
    'ignora a sincronização quando falta %s',
    async (key) => {
      setConfig({ [key]: '' });

      await service.synchronize();

      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('não escreve tokens ou secrets nos avisos de falha', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchSpy.mockRejectedValueOnce(new Error(`failed ${botToken} ${webhookSecret}`));

    await service.synchronize();

    expect(warn.mock.calls.flat().join(' ')).not.toContain(botToken);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(webhookSecret);
  });
});
