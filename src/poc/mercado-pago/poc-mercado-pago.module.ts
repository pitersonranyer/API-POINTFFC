import { Module } from '@nestjs/common';
import { MercadoPagoClient } from './mercado-pago.client';
import { MercadoPagoWebhookController } from './mercado-pago-webhook.controller';
import { PocMercadoPagoController } from './poc-mercado-pago.controller';
import { PocMercadoPagoService } from './poc-mercado-pago.service';

@Module({ controllers: [PocMercadoPagoController, MercadoPagoWebhookController],
  providers: [MercadoPagoClient, PocMercadoPagoService] })
export class PocMercadoPagoModule {}
