import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { FutebolModule } from './futebol.module';
import { FutebolSchedulerService } from './futebol-scheduler.service';

@Module({ imports: [ConfigModule, PrismaModule, FutebolModule], providers: [FutebolSchedulerService] })
export class FutebolSchedulerModule {}
