import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { CompeticaoCardDto } from '../ligas-competicoes/dto/ligas-competicoes-response.dto';
import { TelegramCompetitionsService } from './telegram-competitions.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';

const COMPETITIONS_BUTTON = '🏆 Ver competições';
const WELCOME_MESSAGE = `⚽ Bem-vindo ao POINT FFC Connect!

Consulte as competições públicas disponíveis no POINT FFC pelo botão abaixo.

🌐 https://pointffc.com.br`;
const EMPTY_COMPETITIONS_MESSAGE = 'No momento, não há competições abertas para divulgação.';
const COMPETITIONS_ERROR_MESSAGE = 'Não foi possível consultar as competições agora. Tente novamente em instantes.';
const UNKNOWN_MESSAGE = `⚽ Use o botão abaixo para consultar as competições disponíveis.

Envie /start para ver o menu novamente.`;
const LINK_RATE_LIMIT_MESSAGE = 'Você atingiu o limite de solicitações de vínculo. Tente novamente mais tarde.';
const TELEGRAM_API_TIMEOUT_MS = 5000;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SAFE_MESSAGE_LIMIT = 3900;
const MAX_REMEMBERED_UPDATES = 1000;

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
    if (!message) return;

    const updateId = this.getUpdateId(update);
    if (updateId !== undefined && this.completedUpdates.has(updateId)) return;
    if (updateId !== undefined) {
      const inFlight = this.inFlightUpdates.get(updateId);
      if (inFlight) return inFlight;
    }

    const processing = this.processMessage(message);
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
      await this.sendOrFail(message.chat.id, WELCOME_MESSAGE);
      return;
    }

    if (this.isLinkCommand(text)) {
      await this.createLinkRequest(message);
      return;
    }

    if (text === COMPETITIONS_BUTTON) {
      await this.sendCompetitions(message.chat.id);
      return;
    }

    await this.sendOrFail(message.chat.id, UNKNOWN_MESSAGE);
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
        `🔐 Seu código de vinculação POINT FFC é:\n\n${request.code}\n\nEle expira em 10 minutos e pode ser usado uma única vez. Informe-o na sua conta POINT FFC para concluir a vinculação.`,
      );
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

  private async sendOrFail(chatId: number | string, text: string): Promise<void> {
    if (!await this.sendMessage(chatId, text)) {
      throw new ServiceUnavailableException('Resposta Telegram não enviada.');
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

  private async sendMessage(chatId: number | string, text: string): Promise<boolean> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken?.trim()) {
      this.logger.warn('Resposta Telegram não enviada: configuração do bot ausente.');
      return false;
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
            reply_markup: {
              keyboard: [[{ text: COMPETITIONS_BUTTON }]],
              resize_keyboard: true,
            },
          }),
          signal: controller.signal,
        },
      );

      let telegramAccepted = false;
      if (response.ok) {
        try {
          const result: unknown = await response.json();
          telegramAccepted = this.isRecord(result) && result.ok === true;
        } catch {
          telegramAccepted = false;
        }
      }
      if (!telegramAccepted) this.logger.warn('Resposta Telegram não enviada: API retornou erro.');
      return telegramAccepted;
    } catch {
      this.logger.warn('Resposta Telegram não enviada: falha de comunicação.');
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
