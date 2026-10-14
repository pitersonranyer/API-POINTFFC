import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { CompeticaoCardDto } from '../ligas-competicoes/dto/ligas-competicoes-response.dto';
import { TelegramCompetitionsService } from './telegram-competitions.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramSelectionCallback, TelegramSelectionService, TelegramSelectionResponse } from './telegram-selection.service';

const COMPETITIONS_BUTTON = '🏆 Ver competições';
const CONNECT_ACCOUNT_BUTTON = '🔗 Conectar minha conta';
const PARTICIPATE_FREE_BUTTON = '⚽ Participar grátis';
const LINK_WEBSITE_BUTTON = '🌐 Vincular no POINT FFC';
const LINK_WEBSITE_URL = 'https://pointffc.com.br/conectar-telegram/';
const LINK_COMPLETION_MESSAGE = 'Agora é só concluir sua vinculação no POINT FFC! ⚽\n\nToque no botão abaixo, faça login se necessário e informe o código que você acabou de receber.';
const WELCOME_MESSAGE = `⚽ Bem-vindo ao POINT FFC Connect!

Consulte as competições públicas, participe de competições gratuitas ou conecte sua conta POINT FFC pelos botões abaixo.

🌐 https://pointffc.com.br`;
const EMPTY_COMPETITIONS_MESSAGE = 'No momento, não há competições abertas para divulgação.';
const COMPETITIONS_ERROR_MESSAGE = 'Não foi possível consultar as competições agora. Tente novamente em instantes.';
const UNKNOWN_MESSAGE = `⚽ Use os botões abaixo para consultar as competições ou conectar sua conta POINT FFC.

Envie /start para ver o menu novamente.`;
const LINK_RATE_LIMIT_MESSAGE = 'Você atingiu o limite de solicitações de vínculo. Tente novamente mais tarde.';
const TELEGRAM_API_TIMEOUT_MS = 5000;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SAFE_MESSAGE_LIMIT = 3900;
const MAX_REMEMBERED_UPDATES = 1000;

type TelegramReplyMarkup =
  | { keyboard: Array<Array<{ text: string }>>; resize_keyboard: true; is_persistent: true }
  | { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> };

interface TelegramCallbackQuery {
  id: string;
  fromId?: string;
  chatId?: number | string;
  chatType?: string;
  messageId?: number;
  data?: string;
}

interface TelegramMessageSendResult {
  accepted: boolean;
  messageId?: number;
}

const MAIN_REPLY_KEYBOARD: TelegramReplyMarkup = {
  keyboard: [[{ text: COMPETITIONS_BUTTON }], [{ text: CONNECT_ACCOUNT_BUTTON }], [{ text: PARTICIPATE_FREE_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

const LINK_WEBSITE_KEYBOARD: TelegramReplyMarkup = {
  inline_keyboard: [[{ text: LINK_WEBSITE_BUTTON, url: LINK_WEBSITE_URL }]],
};

interface TelegramMessage {
  chat: {
    id: number | string;
    type: string;
  };
  from?: { id: number | string };
  text: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly completedUpdates = new Map<number, true>();
  private readonly inFlightUpdates = new Map<number, Promise<void>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly competitionsService: TelegramCompetitionsService,
    private readonly telegramLinks: TelegramLinkService,
    private readonly selectionService: TelegramSelectionService,
  ) {}

  async handleWebhook(secretToken: string | undefined, update: unknown): Promise<void> {
    const configuredSecret = this.configService.get<string>('TELEGRAM_WEBHOOK_SECRET');

    if (!configuredSecret?.trim()) {
      throw new ServiceUnavailableException('Integração Telegram indisponível.');
    }

    if (!secretToken || !this.secretsMatch(configuredSecret, secretToken)) {
      throw new UnauthorizedException('Requisição Telegram não autorizada.');
    }

    const message = this.getSupportedPrivateTextMessage(update);
    const callback = this.getCallbackQuery(update);
    if (!message && !callback) return;

    const updateId = this.getUpdateId(update);
    if (updateId !== undefined && this.completedUpdates.has(updateId)) {
      if (callback) {
        try { await this.answerCallbackQuery(callback.id, 'Esta ação já foi processada.'); } catch { /* duplicate callbacks are not replayed */ }
      }
      return;
    }
    if (updateId !== undefined) {
      const inFlight = this.inFlightUpdates.get(updateId);
      if (inFlight) return inFlight;
    }

    const processing = callback ? this.processCallback(callback) : this.processMessage(message!);
    if (updateId === undefined) return processing;

    this.inFlightUpdates.set(updateId, processing);
    try {
      await processing;
      this.rememberCompletedUpdate(updateId);
    } finally {
      this.inFlightUpdates.delete(updateId);
    }
  }

  private async processMessage(message: TelegramMessage): Promise<void> {
    const text = message.text.trim();
    if (this.isStartCommand(text)) {
      if (message.from) this.selectionService.clear(String(message.from.id));
      await this.sendOrFail(message.chat.id, WELCOME_MESSAGE);
      return;
    }

    if (this.isLinkCommand(text) || text === CONNECT_ACCOUNT_BUTTON) {
      if (message.from) this.selectionService.clear(String(message.from.id));
      await this.createLinkRequest(message);
      return;
    }

    if (text === COMPETITIONS_BUTTON) {
      if (message.from) this.selectionService.clear(String(message.from.id));
      await this.sendCompetitions(message.chat.id);
      return;
    }

    if (text === PARTICIPATE_FREE_BUTTON) {
      if (!message.from) {
        await this.sendOrFail(message.chat.id, 'Não foi possível identificar sua conta Telegram. Toque no botão novamente no chat privado do bot.');
        return;
      }
      const response = await this.selectionService.start(String(message.from.id));
      await this.sendSelectionResponse(message.chat.id, response, String(message.from.id));
      return;
    }

    if (message.from) {
      const response = await this.selectionService.handle(String(message.from.id), text);
      if (response) {
        await this.sendSelectionResponse(message.chat.id, response, String(message.from.id));
        return;
      }
    }

    await this.sendOrFail(message.chat.id, UNKNOWN_MESSAGE);
  }

  private async processCallback(callback: TelegramCallbackQuery): Promise<void> {
    if (!callback.fromId || !this.isValidTelegramUserId(callback.fromId)
      || !callback.chatId || !this.isValidChatId(callback.chatId)
      || callback.chatType !== 'private' || !Number.isSafeInteger(callback.messageId)
      || !callback.data) {
      await this.answerCallbackQuery(callback.id, 'Esta seleção não é válida. Inicie novamente pelo menu.');
      return;
    }

    const input: TelegramSelectionCallback = {
      telegramUserId: callback.fromId,
      chatId: String(callback.chatId),
      messageId: callback.messageId!,
      data: callback.data,
    };
    const response = await this.selectionService.handleCallback(input);
    if (response?.editMessage) {
      const edited = await this.editMessageText(callback.chatId, callback.messageId!, response);
      if (!edited) {
        if (response.text.startsWith('🏆 Inscrição realizada com sucesso!')) {
          const receipt = await this.sendMessage(callback.chatId, response.text, undefined, null);
          for (const text of response.followUpMessages ?? []) {
            const sent = await this.sendMessage(callback.chatId, text, undefined, null);
            if (!sent.accepted) this.logger.warn('Continuação do comprovante de inscrição Telegram não enviada.');
          }
          this.logger.warn(receipt.accepted
            ? 'Comprovante de inscrição Telegram enviado em uma nova mensagem.'
            : 'Comprovante de inscrição Telegram não enviado; o resultado permanece recuperável pela chave da operação.');
          await this.answerCallbackQuery(callback.id, receipt.accepted
            ? 'Inscrição confirmada.'
            : 'Inscrição confirmada, mas o comprovante não foi enviado. Toque novamente neste botão para recuperar o resultado.');
          return;
        }
        this.logger.warn('Mensagem interativa Telegram não atualizada; a sessão foi encerrada para evitar seleção divergente.');
        this.selectionService.clearIfSession(callback.fromId, response.sessionToken);
        await this.answerCallbackQuery(callback.id, 'Não foi possível atualizar a seleção. Inicie novamente pelo menu.');
        return;
      }
    }
    await this.answerCallbackQuery(
      callback.id,
      response?.answerText ?? (response ? undefined : 'Esta seleção expirou ou foi substituída. Inicie novamente pelo menu.'),
    );
    for (const text of response?.followUpMessages ?? []) {
      const sent = await this.sendMessage(callback.chatId, text, undefined, null);
      if (!sent.accepted) this.logger.warn('Continuação do resumo de seleção Telegram não enviada.');
    }
  }

  private async sendSelectionResponse(chatId: number | string, response: TelegramSelectionResponse, telegramUserId?: string): Promise<void> {
    const replyMarkup: TelegramReplyMarkup = response.inlineKeyboard
      ? { inline_keyboard: response.inlineKeyboard }
      : {
        keyboard: (response.buttons ?? []).map(row => row.map(text => ({ text }))),
        resize_keyboard: true,
        is_persistent: true,
      };
    const result = await this.sendMessage(chatId, response.text, undefined, replyMarkup);
    if (!result.accepted) throw new ServiceUnavailableException('Resposta Telegram não enviada.');
    if (response.sessionToken) {
      const attached = result.messageId !== undefined && telegramUserId
        && this.selectionService.attachInlineMessage(telegramUserId, response.sessionToken, String(chatId), result.messageId);
      if (!attached) {
        this.selectionService.clearIfSession(telegramUserId ?? '', response.sessionToken);
        this.logger.warn('Mensagem de seleção Telegram sem vínculo válido com a sessão.');
        throw new ServiceUnavailableException('Resposta Telegram não enviada.');
      }
    }
  }

  private async createLinkRequest(message: TelegramMessage): Promise<void> {
    if (!message.from || !this.isValidTelegramUserId(message.from.id)) {
      await this.sendOrFail(message.chat.id, 'Não foi possível iniciar a vinculação. Envie /vincular novamente no chat privado do bot.');
      return;
    }

    try {
      const request = await this.telegramLinks.createRequest(String(message.from.id));
      await this.sendOrFail(
        message.chat.id,
        'Seu código de vinculação está pronto! 🔐\n\nCopie o código da próxima mensagem e informe no site POINT FFC.\n\n⏱️ Validade: 10 minutos.',
      );
      await this.sendOrFail(message.chat.id, request.code, [
        { type: 'code', offset: 0, length: request.code.length },
      ], null);
      await this.sendLinkCompletion(message.chat.id);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        await this.sendOrFail(message.chat.id, LINK_RATE_LIMIT_MESSAGE);
        return;
      }
      throw error;
    }
  }

  private async sendCompetitions(chatId: number | string): Promise<void> {
    let competitions: CompeticaoCardDto[];
    try {
      competitions = await this.competitionsService.listarDivulgaveis();
    } catch {
      this.logger.warn('Consulta de competições Telegram falhou.');
      await this.sendOrFail(chatId, COMPETITIONS_ERROR_MESSAGE);
      return;
    }

    if (competitions.length === 0) {
      await this.sendOrFail(chatId, EMPTY_COMPETITIONS_MESSAGE);
      return;
    }

    for (const text of this.formatCompetitionMessages(competitions)) {
      await this.sendOrFail(chatId, text);
    }
  }

  private async sendOrFail(
    chatId: number | string,
    text: string,
    entities?: Array<{ type: 'code'; offset: number; length: number }>,
    replyMarkup: TelegramReplyMarkup | null = MAIN_REPLY_KEYBOARD,
  ): Promise<void> {
    if (!(await this.sendMessage(chatId, text, entities, replyMarkup)).accepted) {
      throw new ServiceUnavailableException('Resposta Telegram não enviada.');
    }
  }

  private async sendLinkCompletion(chatId: number | string): Promise<void> {
    try {
      const sent = await this.sendMessage(chatId, LINK_COMPLETION_MESSAGE, undefined, LINK_WEBSITE_KEYBOARD);
      if (!sent.accepted) {
        this.logger.warn('Botão de navegação Telegram não enviado; o código já emitido permanece válido.');
      }
    } catch {
      this.logger.warn('Botão de navegação Telegram não enviado; o código já emitido permanece válido.');
    }
  }

  private formatCompetitionMessages(competitions: CompeticaoCardDto[]): string[] {
    const messages: string[] = [];
    const header = '🏆 Competições abertas no POINT FFC\n\n';
    let current = header;

    for (const competition of competitions) {
      const block = this.formatCompetition(competition);
      if (current.trim() && current.length + block.length + 2 > TELEGRAM_SAFE_MESSAGE_LIMIT) {
        messages.push(current.trim());
        current = header;
      }

      const next = `${current}${current.endsWith('\n\n') ? '' : '\n\n'}${block}`;
      if (next.length <= TELEGRAM_SAFE_MESSAGE_LIMIT) {
        current = next;
      } else {
        // Keep Telegram text below its hard limit even when a database field is unexpectedly long.
        const boundedBlock = `${block.slice(0, TELEGRAM_SAFE_MESSAGE_LIMIT - 24)}\n…\nhttps://pointffc.com.br/competicoes?id=${competition.id}`;
        if (current) messages.push(current);
        messages.push(boundedBlock.slice(0, TELEGRAM_MESSAGE_LIMIT));
        current = '';
      }
    }

    if (current.trim()) messages.push(current.trim());
    return messages;
  }

  private formatCompetition(competition: CompeticaoCardDto): string {
    const name = this.truncate(competition.nome, 180);
    const round = competition.rodadaInicio === null
      ? null
      : competition.rodadaFim !== null && competition.rodadaFim !== competition.rodadaInicio
        ? `${competition.rodadaInicio}–${competition.rodadaFim}`
        : competition.rodadaInicio;
    const lines = [`🏆 ${name}`];
    if (round !== null) lines.push(`Rodada: ${round}`);
    lines.push(`Valor: ${competition.tipoAcesso === 'FREE' ? 'Grátis' : this.formatMoney(competition.valorInscricao)}`);
    if (competition.fimInscricao) lines.push(`Inscrições até: ${this.formatDate(competition.fimInscricao)}`);
    lines.push(`🔗 https://pointffc.com.br/competicoes?id=${competition.id}`);
    return lines.join('\n');
  }

  private formatMoney(value: number): string {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  private formatDate(value: string): string {
    return new Date(value).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  private truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  }

  private getSupportedPrivateTextMessage(update: unknown): TelegramMessage | undefined {
    if (!this.isRecord(update) || !this.isRecord(update.message)) return undefined;

    const message = update.message;
    if (
      !this.isRecord(message.chat) ||
      message.chat.type !== 'private' ||
      typeof message.text !== 'string'
    ) {
      return undefined;
    }

    const chatId = message.chat.id;
    if (!this.isValidChatId(chatId)) return undefined;

    const from = this.isRecord(message.from) && this.isValidTelegramUserId(message.from.id)
      ? { id: message.from.id }
      : undefined;

    return { chat: { id: chatId, type: 'private' }, from, text: message.text };
  }

  private getCallbackQuery(update: unknown): TelegramCallbackQuery | undefined {
    if (!this.isRecord(update) || !this.isRecord(update.callback_query)) return undefined;
    const query = update.callback_query;
    if (typeof query.id !== 'string' || query.id.length === 0) return undefined;
    const fromId = this.isRecord(query.from) && this.isValidTelegramUserId(query.from.id)
      ? String(query.from.id) : undefined;
    const message = this.isRecord(query.message) ? query.message : undefined;
    const chat = message && this.isRecord(message.chat) ? message.chat : undefined;
    return {
      id: query.id,
      fromId,
      chatId: chat && this.isValidChatId(chat.id) ? chat.id : undefined,
      chatType: typeof chat?.type === 'string' ? chat.type : undefined,
      messageId: message && typeof message.message_id === 'number' && Number.isSafeInteger(message.message_id)
        ? message.message_id : undefined,
      data: typeof query.data === 'string' ? query.data : undefined,
    };
  }

  private getUpdateId(update: unknown): number | undefined {
    if (!this.isRecord(update) || typeof update.update_id !== 'number' || !Number.isSafeInteger(update.update_id)) {
      return undefined;
    }
    return update.update_id;
  }

  private rememberCompletedUpdate(updateId: number): void {
    this.completedUpdates.set(updateId, true);
    if (this.completedUpdates.size > MAX_REMEMBERED_UPDATES) {
      const oldest = this.completedUpdates.keys().next().value;
      if (oldest !== undefined) this.completedUpdates.delete(oldest);
    }
  }

  private isValidChatId(value: unknown): value is number | string {
    if (typeof value === 'number') return Number.isSafeInteger(value);
    return typeof value === 'string' && value.length > 0;
  }

  private isStartCommand(text: string): boolean {
    return /^\/start(?:@PointFFCConnectBot)?(?:\s|$)/i.test(text);
  }

  private isLinkCommand(text: string): boolean {
    return /^\/vincular(?:@PointFFCConnectBot)?(?:\s|$)/i.test(text);
  }

  private isValidTelegramUserId(value: unknown): value is number | string {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
    return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
  }

  private secretsMatch(configuredSecret: string, providedSecret: string): boolean {
    const configuredBuffer = Buffer.from(configuredSecret, 'utf8');
    const providedBuffer = Buffer.from(providedSecret, 'utf8');

    return (
      configuredBuffer.length === providedBuffer.length &&
      timingSafeEqual(configuredBuffer, providedBuffer)
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async sendMessage(
    chatId: number | string,
    text: string,
    entities?: Array<{ type: 'code'; offset: number; length: number }>,
    replyMarkup: TelegramReplyMarkup | null = MAIN_REPLY_KEYBOARD,
  ): Promise<TelegramMessageSendResult> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken?.trim()) {
      this.logger.warn('Resposta Telegram não enviada: configuração do bot ausente.');
      return { accepted: false };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);

    try {
      const response = await fetch(
        'https://api.telegram.org/bot' + botToken + '/sendMessage',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...(entities ? { entities } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          }),
          signal: controller.signal,
        },
      );

      let telegramAccepted = false;
      let messageId: number | undefined;
      if (response.ok) {
        try {
          const result: unknown = await response.json();
          if (this.isRecord(result) && result.ok === true) {
            telegramAccepted = true;
            if (this.isRecord(result.result) && Number.isSafeInteger(result.result.message_id)) {
              messageId = result.result.message_id as number;
            }
          }
        } catch {
          telegramAccepted = false;
        }
      }
      if (!telegramAccepted) this.logger.warn('Resposta Telegram não enviada: API retornou erro.');
      return { accepted: telegramAccepted, messageId };
    } catch {
      this.logger.warn('Resposta Telegram não enviada: falha de comunicação.');
      return { accepted: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async editMessageText(
    chatId: number | string,
    messageId: number,
    response: TelegramSelectionResponse,
  ): Promise<boolean> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken?.trim()) {
      this.logger.warn('Edição de mensagem Telegram não realizada: configuração do bot ausente.');
      return false;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);
    try {
      const result = await fetch('https://api.telegram.org/bot' + botToken + '/editMessageText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: response.text,
          reply_markup: { inline_keyboard: response.inlineKeyboard ?? [] },
        }),
        signal: controller.signal,
      });
      let accepted = false;
      if (result.ok) {
        try {
          const payload: unknown = await result.json();
          accepted = this.isRecord(payload) && payload.ok === true;
        } catch {
          accepted = false;
        }
      }
      if (!accepted) this.logger.warn('Edição de mensagem Telegram rejeitada pela API.');
      return accepted;
    } catch {
      this.logger.warn('Edição de mensagem Telegram falhou por erro de comunicação.');
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken?.trim()) {
      this.logger.warn('Callback Telegram não respondido: configuração do bot ausente.');
      throw new ServiceUnavailableException('Resposta Telegram indisponível.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.telegram.org/bot' + botToken + '/answerCallbackQuery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
        signal: controller.signal,
      });
      let accepted = false;
      if (response.ok) {
        try {
          const payload: unknown = await response.json();
          accepted = this.isRecord(payload) && payload.ok === true;
        } catch {
          accepted = false;
        }
      }
      if (!accepted) {
        this.logger.warn('Callback Telegram não confirmado pela API.');
        throw new ServiceUnavailableException('Resposta Telegram indisponível.');
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn('Callback Telegram não respondido por falha de comunicação.');
      throw new ServiceUnavailableException('Resposta Telegram indisponível.');
    } finally {
      clearTimeout(timeout);
    }
  }
}
