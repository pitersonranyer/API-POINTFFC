import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DesafiosController } from './desafios.controller';
import { DesafiosService } from './desafios.service';

@Module({ imports: [AuthModule, PrismaModule], controllers: [DesafiosController], providers: [DesafiosService] })
export class DesafiosModule {}
