import { Module } from '@nestjs/common';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramService } from './telegram.service';
import { LigasCompeticoesModule } from '../ligas-competicoes/ligas-competicoes.module';
import { TelegramCompetitionsService } from './telegram-competitions.service';
import { TelegramLinkModule } from '../telegram-link/telegram-link.module';
import { MeusTimesModule } from '../meus-times/meus-times.module';
import { TelegramSelectionService } from './telegram-selection.service';
import { TelegramWebhookSyncService } from './telegram-webhook-sync.service';
import { CartolaModule } from '../cartola/cartola.module';

@Module({
  imports: [LigasCompeticoesModule, TelegramLinkModule, MeusTimesModule, CartolaModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramService, TelegramCompetitionsService, TelegramSelectionService, TelegramWebhookSyncService],
})
export class TelegramModule {}
