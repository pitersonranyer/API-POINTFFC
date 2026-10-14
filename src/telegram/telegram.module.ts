import { Module } from '@nestjs/common';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramService } from './telegram.service';
import { LigasCompeticoesModule } from '../ligas-competicoes/ligas-competicoes.module';
import { TelegramCompetitionsService } from './telegram-competitions.service';
import { TelegramLinkModule } from '../telegram-link/telegram-link.module';

@Module({
  imports: [LigasCompeticoesModule, TelegramLinkModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramService, TelegramCompetitionsService],
})
export class TelegramModule {}
