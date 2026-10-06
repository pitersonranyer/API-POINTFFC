import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiFootballClient } from './api-football.client';
import { FantasyController } from './fantasy.controller';
import { FantasyService } from './fantasy.service';

@Module({ imports: [ConfigModule], controllers: [FantasyController], providers: [FantasyService, ApiFootballClient] })
export class FantasyModule {}
