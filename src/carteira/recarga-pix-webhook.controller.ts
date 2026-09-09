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
    console.error(JSON.stringify({ marker: 'WEBHOOK_CARTEIRA_CONTROLLER_ENTROU', timestamp: new Date().toISOString() }));
    console.error(JSON.stringify({ marker: 'WEBHOOK_CARTEIRA_RECEBIDO', level: 'error',
      timestamp: new Date().toISOString(), signaturePresent: typeof signature === 'string' && Boolean(signature.trim()),
      requestIdPresent: typeof requestId === 'string' && Boolean(requestId.trim()) }));
    return this.service.webhook(signature, requestId, dataId);
  }
}
