import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

describe('TelegramService', () => {
  const webhookSecret = 'test-webhook-secret';
  const botToken = '123456:test-bot-token';
  const competitions = [
    { id: 42, nome: 'POINT FFC - Rodada 27', slug: 'rodada-27', tipoAcesso: 'FREE',
      valorInscricao: 0, rodadaInicio: 27, rodadaFim: 27, fimInscricao: '2026-10-14T23:59:00.000Z' },
    { id: 43, nome: 'POINT FFC - Liga Premium', slug: 'liga-premium', tipoAcesso: 'PAGO',
      valorInscricao: 5, rodadaInicio: 27, rodadaFim: 27, fimInscricao: '2026-10-14T23:59:00.000Z' },
  ];
  let fetchSpy: jest.SpyInstance;
  let competitionsService: { listarDivulgaveis: jest.Mock };
  let telegramLinks: { createRequest: jest.Mock; resolveActiveUserId: jest.Mock };
  let selectionService: {
    start: jest.Mock;
    startMyRegistrations: jest.Mock;
    handle: jest.Mock;
    handleCallback: jest.Mock;
    attachInlineMessage: jest.Mock;
    clear: jest.Mock;
    clearIfSession: jest.Mock;
  };

  const createService = (values: Record<string, string | undefined> = {}) => {
    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    return new TelegramService(configService, competitionsService as never, telegramLinks as never, selectionService as never);
  };

  const privateMessage = (text: string, chatId: number | string = 12345) => ({
    message: {
      chat: { id: chatId, type: 'private' },
      text,
    },
  });

  beforeEach(() => {
    competitionsService = { listarDivulgaveis: jest.fn().mockResolvedValue(competitions) };
    telegramLinks = {
      createRequest: jest.fn().mockResolvedValue({ code: 'a'.repeat(48), expiresAt: new Date('2026-10-14T12:00:00Z') }),
      resolveActiveUserId: jest.fn().mockResolvedValue(null),
    };
    selectionService = {
      start: jest.fn().mockResolvedValue({ text: 'Selecione uma competição gratuita.', buttons: [], inlineKeyboard: [[{ text: 'Rodada 27', callback_data: 'pfc:test:nonce:select-competition:16' }]] }),
      startMyRegistrations: jest.fn().mockResolvedValue({ text: '📋 Minhas inscrições', buttons: [], inlineKeyboard: [[{ text: '🏠 Menu principal', callback_data: 'pfc:test:nonce:main-menu' }]] }),
      handle: jest.fn().mockResolvedValue(null),
      handleCallback: jest.fn().mockResolvedValue(null),
      attachInlineMessage: jest.fn().mockReturnValue(true),
      clear: jest.fn(),
      clearIfSession: jest.fn(),
    };
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
    expect(requestBody.reply_markup.keyboard.map(row => row.map(button => button.text))).toEqual([
      ['🏆 Competições', '⚽ Participar grátis'], ['📋 Minhas inscrições', '🔗 Minha conta'],
    ]);
  });

  it('routes the new competition label and keeps the old label compatible', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, { update_id: 820, message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '🏆 Competições' } });
    await service.handleWebhook(webhookSecret, { update_id: 821, ...privateMessage('🏆 Ver competições') });
    expect(competitionsService.listarDivulgaveis).toHaveBeenCalledTimes(2);
  });

  it('shows linked account status with a safe site button', async () => {
    telegramLinks.resolveActiveUserId.mockResolvedValue(42);
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, {
      update_id: 822,
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '🔗 Minha conta' },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(telegramLinks.resolveActiveUserId).toHaveBeenCalledWith('54321');
    expect(body.text).toContain('Sua conta POINT FFC está conectada');
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({ text: '🌐 Acessar POINT FFC', url: 'https://pointffc.com.br' });
    expect(body.text).not.toContain('42');
  });

  it('starts account linking when Minha conta has no active link and routes Minhas inscrições', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, { update_id: 823, message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '🔗 Minha conta' } });
    expect(telegramLinks.createRequest).toHaveBeenCalledWith('54321');
    fetchSpy.mockClear();
    await service.handleWebhook(webhookSecret, { update_id: 824, message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '📋 Minhas inscrições' } });
    expect(selectionService.startMyRegistrations).toHaveBeenCalledWith('54321');
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).reply_markup.inline_keyboard[0][0].text)
      .toBe('🏠 Menu principal');
  });

  it('sends all three link messages in order and isolates the code without logging it', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    const logger = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
    await service.handleWebhook(webhookSecret, {
      update_id: 811,
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '/vincular' },
    });

    expect(telegramLinks.createRequest).toHaveBeenCalledWith('54321');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const orientation = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      text: string;
      reply_markup: { keyboard: Array<Array<{ text: string }>>; is_persistent: boolean };
    };
    const codeMessage = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string) as {
      text: string;
      entities: Array<{ type: string; offset: number; length: number }>;
    };
    const completion = JSON.parse(fetchSpy.mock.calls[2][1]?.body as string) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
    };
    expect(orientation.text).toBe('Seu código de vinculação está pronto! 🔐\n\nCopie o código da próxima mensagem e informe no site POINT FFC.\n\n⏱️ Validade: 10 minutos.');
    expect(orientation.reply_markup.keyboard.flat().map(button => button.text)).toEqual([
      '🏆 Competições', '⚽ Participar grátis', '📋 Minhas inscrições', '🔗 Minha conta',
    ]);
    expect(orientation.reply_markup.is_persistent).toBe(true);
    expect(codeMessage.text).toMatch(/^[a-f0-9]{48}$/);
    expect(codeMessage.text).toBe('a'.repeat(48));
    expect(codeMessage.entities).toEqual([{ type: 'code', offset: 0, length: 48 }]);
    expect(Object.keys(codeMessage)).toEqual(['chat_id', 'text', 'entities']);
    expect(completion.text).toBe('Agora é só concluir sua vinculação no POINT FFC! ⚽\n\nToque no botão abaixo, faça login se necessário e informe o código que você acabou de receber.');
    expect(completion.reply_markup.inline_keyboard).toEqual([[
      { text: '🌐 Vincular no POINT FFC', url: 'https://pointffc.com.br/conectar-telegram/' },
    ]]);
    expect(completion.reply_markup.inline_keyboard[0][0].url).not.toContain(codeMessage.text);
    expect(completion.text).not.toContain(codeMessage.text);
    expect(logger).not.toHaveBeenCalled();
  });

  it('starts the same private linking flow when the menu button is selected', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, {
      update_id: 812,
      message: {
        chat: { id: 12345, type: 'private' },
        from: { id: 54321 },
        text: '🔗 Conectar minha conta',
      },
    });

    expect(telegramLinks.createRequest).toHaveBeenCalledWith('54321');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).text).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.parse(fetchSpy.mock.calls[2][1]?.body as string).reply_markup.inline_keyboard[0][0].url)
      .toBe('https://pointffc.com.br/conectar-telegram/');
  });

  it('does not regenerate or invalidate the delivered code when the navigation button send fails', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    fetchSpy.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ ok: true }) } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ ok: true }) } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({ ok: false } as Response);
    const logger = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
    const update = {
      update_id: 816,
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '/vincular' },
    };

    await expect(service.handleWebhook(webhookSecret, update)).resolves.toBeUndefined();
    const deliveredCode = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).text as string;
    expect(deliveredCode).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(deliveredCode);
    expect(JSON.stringify(logger.mock.calls)).toContain('código já emitido permanece válido');

    await expect(service.handleWebhook(webhookSecret, update)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(telegramLinks.createRequest).toHaveBeenCalledTimes(1);
  });

  it('does not create link requests without a validated private Telegram sender ID', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, {
      message: { chat: { id: 12345, type: 'private' }, text: '/vincular' },
    });
    expect(telegramLinks.createRequest).not.toHaveBeenCalled();
  });

  it('does not issue a link code from a group chat even when the menu button is used', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, {
      update_id: 813,
      message: {
        chat: { id: -100, type: 'group' },
        from: { id: 54321 },
        text: '🔗 Conectar minha conta',
      },
    });
    expect(telegramLinks.createRequest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps /vincular working and does not send the code if the orientation fails', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    fetchSpy.mockRejectedValueOnce(new Error('network failure'));
    const logger = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');

    await expect(service.handleWebhook(webhookSecret, {
      update_id: 814,
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '/vincular' },
    })).rejects.toThrow(ServiceUnavailableException);

    expect(telegramLinks.createRequest).toHaveBeenCalledWith('54321');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('a'.repeat(48));
  });

  it('leaves a failed code send retryable and never logs the code', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    fetchSpy.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ ok: true }) } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({ ok: false } as Response);
    const logger = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
    const update = {
      update_id: 815,
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '🔗 Conectar minha conta' },
    };

    await expect(service.handleWebhook(webhookSecret, update)).rejects.toThrow(ServiceUnavailableException);
    const attemptedCodeMessage = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string) as { text: string };
    expect(attemptedCodeMessage.text).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(attemptedCodeMessage.text);

    fetchSpy.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ ok: true }) } as unknown as Response);
    await expect(service.handleWebhook(webhookSecret, update)).resolves.toBeUndefined();
    expect(telegramLinks.createRequest).toHaveBeenCalledTimes(2);
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
    expect(requestBody.text).toContain('Use os botões abaixo');
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
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '🏆 Ver competições' },
    });

    expect(competitionsService.listarDivulgaveis).toHaveBeenCalledWith();
    expect(selectionService.clear).toHaveBeenCalledWith('54321');
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as { text: string };
    expect(requestBody.text).toContain('POINT FFC - Rodada 27');
    expect(requestBody.text).toContain('Rodada: 27');
    expect(requestBody.text).toContain('Valor: Grátis');
    expect(requestBody.text).toContain('POINT FFC - Liga Premium');
    expect(requestBody.text).toContain('R$ 5,00');
    expect(requestBody.text).toContain('https://pointffc.com.br/competicoes?id=42');
  });

  it('starts the separate free participation journey without changing public competition disclosure', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, {
      update_id: 89,
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '⚽ Participar grátis' },
    });

    expect(selectionService.start).toHaveBeenCalledWith('54321');
    expect(selectionService.clear).not.toHaveBeenCalled();
    expect(competitionsService.listarDivulgaveis).not.toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.text).toContain('Selecione uma competição gratuita.');
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: 'Rodada 27', callback_data: 'pfc:test:nonce:select-competition:16' }]]);
  });

  it('sends the inline team keyboard and binds the returned Telegram message to the session', async () => {
    selectionService.start.mockResolvedValueOnce({
      text: 'Escolha seus times.',
      buttons: [],
      sessionToken: 'session-token-123',
      inlineKeyboard: [[{ text: '⬜ Meu time (#1001)', callback_data: 'pfc:session-token-123:nonce1234:toggle-team:rt' }]],
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true, result: { message_id: 987 } }),
    } as unknown as Response);
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });

    await service.handleWebhook(webhookSecret, {
      update_id: 901,
      message: { chat: { id: 54321, type: 'private' }, from: { id: 54321 }, text: '⚽ Participar grátis' },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^pfc:/);
    expect(selectionService.attachInlineMessage).toHaveBeenCalledWith('54321', 'session-token-123', '54321', 987);
  });

  it('routes private callbacks, edits the same message, and answers the callback query', async () => {
    selectionService.handleCallback.mockResolvedValueOnce({
      text: 'Times selecionados: 1',
      buttons: [],
      inlineKeyboard: [[{ text: '✅ Meu time (#1001)', callback_data: 'new-current-callback' }]],
      editMessage: true,
      sessionToken: 'current-session',
    });
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });

    await service.handleWebhook(webhookSecret, {
      update_id: 902,
      callback_query: {
        id: 'callback-query-1',
        from: { id: 54321 },
        data: 'pfc:session12345678:nonce1234:toggle-team:rt',
        message: { message_id: 987, chat: { id: 54321, type: 'private' } },
      },
    });

    expect(selectionService.handleCallback).toHaveBeenCalledWith({
      telegramUserId: '54321', chatId: '54321', messageId: 987,
      data: 'pfc:session12345678:nonce1234:toggle-team:rt',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${botToken}/editMessageText`);
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)).toMatchObject({
      chat_id: 54321, message_id: 987, text: 'Times selecionados: 1',
    });
    expect(fetchSpy.mock.calls[1][0]).toBe(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`);
    expect(JSON.parse(fetchSpy.mock.calls[1][1]?.body as string)).toEqual({ callback_query_id: 'callback-query-1' });
  });

  it('deduplicates a repeated callback update without editing the selection twice', async () => {
    selectionService.handleCallback.mockResolvedValueOnce({
      text: 'Times selecionados: 1', buttons: [], inlineKeyboard: [], editMessage: true,
    });
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    const update = {
      update_id: 905,
      callback_query: {
        id: 'callback-query-repeat', from: { id: 54321 }, data: 'valid-callback',
        message: { message_id: 987, chat: { id: 54321, type: 'private' } },
      },
    };

    await service.handleWebhook(webhookSecret, update);
    await service.handleWebhook(webhookSecret, update);

    expect(selectionService.handleCallback).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.filter(([url]) => url.endsWith('/editMessageText'))).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => url.endsWith('/answerCallbackQuery'))).toHaveLength(2);
  });

  it('answers invalid and non-private callbacks without passing identity to the selection service', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    await service.handleWebhook(webhookSecret, {
      update_id: 903,
      callback_query: {
        id: 'callback-query-invalid', from: { id: 54321 }, data: 'invalid',
        message: { message_id: 987, chat: { id: -100, type: 'group' } },
      },
    });
    expect(selectionService.handleCallback).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`);
  });

  it('invalidates the matching session and answers safely when editing the selection fails', async () => {
    selectionService.handleCallback.mockResolvedValueOnce({
      text: 'Nova seleção', buttons: [], inlineKeyboard: [], editMessage: true, sessionToken: 'matching-token',
    });
    fetchSpy.mockResolvedValueOnce({ ok: false } as Response);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ ok: true }) } as unknown as Response);
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    const logger = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');

    await service.handleWebhook(webhookSecret, {
      update_id: 904,
      callback_query: {
        id: 'callback-query-edit-failure', from: { id: 54321 }, data: 'valid-callback',
        message: { message_id: 987, chat: { id: 54321, type: 'private' } },
      },
    });

    expect(selectionService.clearIfSession).toHaveBeenCalledWith('54321', 'matching-token');
    expect(fetchSpy.mock.calls[1][0]).toBe(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(botToken);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('valid-callback');
  });

  it('sends a persisted enrollment receipt separately when editing the callback message fails', async () => {
    selectionService.handleCallback.mockResolvedValueOnce({
      text: '🏆 Inscrição realizada com sucesso!\n\nCompetição: Rodada 42\n\nTimes inscritos:\n• Time 1001 (#1001)\n\nTotal: 1 time\nValor: R$ 0,00',
      buttons: [], inlineKeyboard: [
        [{ text: '📋 Minhas inscrições', callback_data: 'pfc:receipt-token:nonce1234:my-inscriptions' }],
        [{ text: '🏠 Menu principal', callback_data: 'pfc:receipt-token:nonce1234:main-menu' }],
      ], sessionToken: 'receipt-token', editMessage: true,
    });
    fetchSpy.mockResolvedValueOnce({ ok: false } as Response);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ ok: true, result: { message_id: 988 } }) } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ ok: true }) } as unknown as Response);
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });

    await service.handleWebhook(webhookSecret, {
      update_id: 906,
      callback_query: {
        id: 'callback-query-enrollment', from: { id: 54321 }, data: 'valid-confirm',
        message: { message_id: 987, chat: { id: 54321, type: 'private' } },
      },
    });

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      `https://api.telegram.org/bot${botToken}/editMessageText`,
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`,
      `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
    ]);
    expect(JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).text).toContain('Inscrição realizada com sucesso!');
    expect(JSON.parse(fetchSpy.mock.calls[1][1]?.body as string).reply_markup.inline_keyboard.flat().map((button: { text: string }) => button.text))
      .toEqual(['📋 Minhas inscrições', '🏠 Menu principal']);
    expect(JSON.parse(fetchSpy.mock.calls[2][1]?.body as string)).toEqual({ chat_id: 54321, message_id: 987, reply_markup: { inline_keyboard: [] } });
    expect(JSON.parse(fetchSpy.mock.calls[3][1]?.body as string)).toEqual({
      callback_query_id: 'callback-query-enrollment', text: 'Inscrição confirmada.',
    });
    expect(selectionService.clearIfSession).not.toHaveBeenCalled();
    expect(selectionService.attachInlineMessage).toHaveBeenCalledWith('54321', 'receipt-token', '54321', 988);
  });

  it('routes in-session text to the selection flow after preserving the existing menu actions', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    selectionService.handle.mockResolvedValueOnce({ text: 'Resumo da seleção', buttons: [['❌ Cancelar']] });
    await service.handleWebhook(webhookSecret, {
      update_id: 90,
      message: { chat: { id: 12345, type: 'private' }, from: { id: 54321 }, text: '1. Rodada 27' },
    });
    expect(selectionService.handle).toHaveBeenCalledWith('54321', '1. Rodada 27');
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).text).toBe('Resumo da seleção');
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

  it('suppresses a repeated update only after its response was sent successfully', async () => {
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

  it('does not mark an update complete when Telegram send fails and retries it on redelivery', async () => {
    const service = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: botToken,
    });
    fetchSpy.mockRejectedValueOnce(new Error('failure'));
    const update = { update_id: 86, ...privateMessage('/start') };

    await expect(service.handleWebhook(webhookSecret, update)).rejects.toThrow(ServiceUnavailableException);
    await expect(service.handleWebhook(webhookSecret, update)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a query-failure update if the generic error message could not be sent', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    competitionsService.listarDivulgaveis.mockRejectedValueOnce(new Error('private database details'));
    fetchSpy.mockRejectedValueOnce(new Error('send failed'));
    const update = { update_id: 87, ...privateMessage('🏆 Ver competições') };

    await expect(service.handleWebhook(webhookSecret, update)).rejects.toThrow(ServiceUnavailableException);
    await expect(service.handleWebhook(webhookSecret, update)).resolves.toBeUndefined();

    expect(competitionsService.listarDivulgaveis).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not send a generic error after a partial list and leaves the update retryable', async () => {
    const service = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret, TELEGRAM_BOT_TOKEN: botToken });
    const longList = Array.from({ length: 24 }, (_, index) => ({
      ...competitions[0], id: index + 42, nome: `Competição ${index + 1} ${'Nome '.repeat(50)}`,
    }));
    competitionsService.listarDivulgaveis.mockResolvedValue(longList);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({ ok: false } as Response);
    const update = { update_id: 88, ...privateMessage('🏆 Ver competições') };

    await expect(service.handleWebhook(webhookSecret, update)).rejects.toThrow(ServiceUnavailableException);
    const firstAttempt = fetchSpy.mock.calls.map(call => JSON.parse(call[1]?.body as string).text as string);
    expect(firstAttempt.length).toBeGreaterThan(1);
    expect(firstAttempt.some(text => text.includes('Não foi possível consultar'))).toBe(false);

    await expect(service.handleWebhook(webhookSecret, update)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(firstAttempt.length * 2);
    expect(competitionsService.listarDivulgaveis).toHaveBeenCalledTimes(2);
  });

  it('does not call Telegram when the bot token is missing or empty', async () => {
    const missingTokenService = createService({ TELEGRAM_WEBHOOK_SECRET: webhookSecret });
    const emptyTokenService = createService({
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      TELEGRAM_BOT_TOKEN: '',
    });

    await expect(missingTokenService.handleWebhook(webhookSecret, privateMessage('/start'))).rejects.toThrow(ServiceUnavailableException);
    await expect(emptyTokenService.handleWebhook(webhookSecret, privateMessage('/start'))).rejects.toThrow(ServiceUnavailableException);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
