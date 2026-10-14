import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_WEBHOOK_URL = 'https://api-pointffc.onrender.com/integracoes/telegram/webhook';
const REQUIRED_UPDATES = ['message', 'callback_query'] as const;
const TELEGRAM_API_TIMEOUT_MS = 5000;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
}

interface TelegramWebhookInfo {
  url?: string;
  allowed_updates?: string[];
}

@Injectable()
export class TelegramWebhookSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramWebhookSyncService.name);

  constructor(private readonly configService: ConfigService) {}

  onApplicationBootstrap(): void {
    void this.synchronize();
  }

  async synchronize(): Promise<void> {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN')?.trim();
    const webhookSecret = this.configService.get<string>('TELEGRAM_WEBHOOK_SECRET')?.trim();

    if (!botToken || !webhookSecret) {
      this.logger.warn('Sincronização do webhook Telegram ignorada: configuração necessária ausente.');
      return;
    }

    const webhookUrl = DEFAULT_WEBHOOK_URL;

    try {
      const infoResponse = await this.callTelegram<TelegramWebhookInfo>(botToken, 'getWebhookInfo');
      if (!infoResponse.ok || !infoResponse.result) {
        this.logger.warn('Não foi possível consultar a configuração do webhook Telegram.');
        return;
      }

      const current = infoResponse.result;
      const configuredUpdates = Array.isArray(current.allowed_updates) ? current.allowed_updates : [];
      const usesTelegramDefaultUpdates = configuredUpdates.length === 0;
      const needsUpdate = current.url !== webhookUrl
        || (!usesTelegramDefaultUpdates && REQUIRED_UPDATES.some((update) => !configuredUpdates.includes(update)));

      if (!needsUpdate) return;

      const payload: Record<string, unknown> = {
        url: webhookUrl,
        secret_token: webhookSecret,
      };
      // An empty or missing list means Telegram's default set; omit the field to retain it.
      if (!usesTelegramDefaultUpdates) {
        payload.allowed_updates = [...new Set([...configuredUpdates, ...REQUIRED_UPDATES])];
      }
      const setResponse = await this.callTelegram<boolean>(botToken, 'setWebhook', {
        ...payload,
      });

      if (!setResponse.ok || setResponse.result !== true) {
        this.logger.warn('Não foi possível sincronizar a configuração do webhook Telegram.');
      }
    } catch {
      // Telegram indisponível não deve impedir o backend de concluir a inicialização.
      this.logger.warn('Falha ao sincronizar o webhook Telegram; a API continuará iniciando normalmente.');
    }
  }

  private async callTelegram<T>(
    botToken: string,
    method: 'getWebhookInfo' | 'setWebhook',
    payload?: Record<string, unknown>,
  ): Promise<TelegramApiResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);

    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
      return await response.json() as TelegramApiResponse<T>;
    } finally {
      clearTimeout(timeout);
    }
  }
}
