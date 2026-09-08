import { Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PocMercadoPagoService } from './poc-mercado-pago.service';

@ApiTags('POC Mercado Pago')
@Controller('webhooks/mercado-pago')
export class MercadoPagoWebhookController {
  constructor(private readonly service: PocMercadoPagoService) {}
  @Post()
  @HttpCode(200)
  receive(@Headers('x-signature') signature: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Query('data.id') dataId: unknown) {
    return this.service.webhook(signature, requestId, dataId);
  }
}
