import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TelegramService } from './telegram.service';

@ApiTags('Telegram')
@Controller('integracoes/telegram')
export class TelegramWebhookController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  receive(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() update: unknown,
  ): Promise<void> {
    return this.telegramService.handleWebhook(secretToken, update);
  }
}
