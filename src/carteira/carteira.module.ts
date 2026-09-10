import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CarteiraService } from './carteira.service';
import { CarteiraController } from './carteira.controller';
import { RecargaCarteiraService } from './recarga-carteira.service';
import { AuthModule } from '../auth/auth.module';
import { MercadoPagoRecargaClient } from './mercado-pago-recarga.client';
import { RecargaPixService } from './recarga-pix.service';
import { RecargaPixController } from './recarga-pix.controller';
import { RecargaPixWebhookController } from './recarga-pix-webhook.controller';

@Module({ imports: [PrismaModule, AuthModule],
  controllers: [CarteiraController, RecargaPixController, RecargaPixWebhookController],
  providers: [CarteiraService, RecargaCarteiraService, MercadoPagoRecargaClient, RecargaPixService],
  exports: [CarteiraService, RecargaCarteiraService] })
export class CarteiraModule {}
