import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

const WELCOME_MESSAGE = `⚽ Bem-vindo ao POINT FFC Connect!

🏆 Aqui você poderá participar das competições POINT FFC diretamente pelo Telegram.

Estamos preparando uma experiência rápida e simples para você inscrever seus times do Cartola.

🌐 https://pointffc.com.br`;

const UNKNOWN_MESSAGE = `⚽ Olá! O POINT FFC Connect está em preparação.

Envie /start para conhecer nosso bot.`;

const TELEGRAM_API_TIMEOUT_MS = 5000;

interface TelegramMessage {
  chat: {
    id: number | string;
    type: string;
  };
  text: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(private readonly configService: ConfigService) {}

  async handleWebhook(secretToken: string | undefined, update: unknown): Promise<void> {
    const configuredSecret = this.configService.get<string>('TELEGRAM_WEBHOOK_SECRET');

    if (!configuredSecret?.trim()) {
      throw new ServiceUnavailableException('Integração Telegram indisponível.');
    }

    if (!secretToken || !this.secretsMatch(configuredSecret, secretToken)) {
      throw new UnauthorizedException('Requisição Telegram não autorizada.');
    }

    const message = this.getSupportedPrivateTextMessage(update);
    if (!message) {
      return;
    }

    const responseText = this.isStartCommand(message.text) ? WELCOME_MESSAGE : UNKNOWN_MESSAGE;
    await this.sendMessage(message.chat.id, responseText);
  }

  private getSupportedPrivateTextMessage(update: unknown): TelegramMessage | undefined {
    if (!this.isRecord(update) || !this.isRecord(update.message)) {
      return undefined;
    }

    const message = update.message;
    if (
      !this.isRecord(message.chat) ||
      message.chat.type !== 'private' ||
      typeof message.text !== 'string'
    ) {
      return undefined;
    }

    const chatId = message.chat.id;
    if (!this.isValidChatId(chatId)) {
      return undefined;
    }

    return {
      chat: { id: chatId, type: 'private' },
      text: message.text,
    };
  }

  private isValidChatId(value: unknown): value is number | string {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value);
    }

    return typeof value === 'string' && value.length > 0;
  }

  private isStartCommand(text: string): boolean {
    return /^\/start(?:@PointFFCConnectBot)?(?:\s|$)/i.test(text.trim());
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

  private async sendMessage(chatId: number | string, text: string): Promise<void> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken?.trim()) {
      this.logger.warn('Resposta Telegram não enviada: configuração do bot ausente.');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);

    try {
      const response = await fetch(
        'https://api.telegram.org/bot' + botToken + '/sendMessage',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        this.logger.warn('Resposta Telegram não enviada: API retornou erro.');
      }
    } catch {
      this.logger.warn('Resposta Telegram não enviada: falha de comunicação.');
    } finally {
      clearTimeout(timeout);
    }
  }
}
