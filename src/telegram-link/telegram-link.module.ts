import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramLinkController } from './telegram-link.controller';
import { TelegramLinkService } from './telegram-link.service';

@Module({
  imports: [AuthModule],
  controllers: [TelegramLinkController],
  providers: [TelegramLinkService],
  exports: [TelegramLinkService],
})
export class TelegramLinkModule {}
