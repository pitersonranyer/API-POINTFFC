import { Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RecargaPixService } from './recarga-pix.service';

@ApiTags('carteira-recargas')
@Controller('webhooks/mercado-pago/carteira')
export class RecargaPixWebhookController {
  constructor(private readonly service: RecargaPixService) {}
  @Post()
  @HttpCode(200)
  receber(@Headers('x-signature') signature: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Query('data.id') dataId: unknown) {
    return this.service.webhook(signature, requestId, dataId);
  }
}
