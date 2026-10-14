import { Module } from '@nestjs/common';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramService } from './telegram.service';

@Module({
  controllers: [TelegramWebhookController],
  providers: [TelegramService],
})
export class TelegramModule {}
