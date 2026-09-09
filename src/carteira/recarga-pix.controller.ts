import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { CriarRecargaPixDto } from './dto/criar-recarga-pix.dto';
import { RecargaPixService } from './recarga-pix.service';

@ApiTags('carteira-recargas')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('carteira/recargas')
export class RecargaPixController {
  constructor(private readonly service: RecargaPixService) {}
  @Post('pix')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '16 a 128 caracteres; reutilizar em retries da mesma recarga' })
  criar(@AuthenticatedUser() usuario: Usuario, @Body() body: CriarRecargaPixDto,
    @Headers('idempotency-key') key: string | undefined) {
    console.error(JSON.stringify({ marker: 'RECARGA_PIX_ENDPOINT_ENTER', level: 'error',
      timestamp: new Date().toISOString(), usuarioId: usuario.idUsuario }));
    return this.service.criar(usuario, body.valor, key);
  }
  @Get(':id')
  consultar(@AuthenticatedUser() usuario: Usuario, @Param('id', ParseIntPipe) id: number) {
    return this.service.consultar(usuario.idUsuario, id);
  }
}
