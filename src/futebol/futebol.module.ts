import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { FootballDataClient } from './football-data.client';
import { FutebolSyncService } from './futebol-sync.service';

@Module({ imports: [ConfigModule, PrismaModule], providers: [FootballDataClient, FutebolSyncService], exports: [FutebolSyncService] })
export class FutebolModule {}
