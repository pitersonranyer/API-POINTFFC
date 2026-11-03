import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiFutebolV2Client } from './api-futebol-v2.client';
import { FantasyController } from './fantasy.controller';
import { FantasyService } from './fantasy.service';

@Module({ imports: [ConfigModule], controllers: [FantasyController], providers: [FantasyService, ApiFutebolV2Client] })
export class FantasyModule {}
