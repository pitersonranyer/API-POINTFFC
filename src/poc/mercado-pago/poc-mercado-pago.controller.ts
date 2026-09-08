import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CriarPixDto } from './dto/criar-pix.dto';
import { PocMercadoPagoService } from './poc-mercado-pago.service';

@ApiTags('POC Mercado Pago')
@Controller('poc/mercado-pago')
export class PocMercadoPagoController {
  constructor(private readonly service: PocMercadoPagoService) {}
  @Post('pix')
  @ApiOperation({ summary: 'Cria PIX de teste, armazenado somente em memória' })
  create(@Body() body: CriarPixDto) { return this.service.create(body.valor); }
  @Get('pix/:id/status')
  @ApiOperation({ summary: 'Consulta a Order e retorna status e QR disponível' })
  status(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.service.status(id); }
  @Get('health')
  health() { return this.service.health(); }
}
