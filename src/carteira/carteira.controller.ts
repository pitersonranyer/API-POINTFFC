import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CarteiraService } from './carteira.service';
import { CarteiraResponseDto } from './dto/carteira-response.dto';

@ApiTags('carteira')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('carteira')
export class CarteiraController {
  constructor(private readonly service: CarteiraService) {}

  @Get()
  @ApiOkResponse({ type: CarteiraResponseDto })
  async consultar(@AuthenticatedUser() usuario: Usuario): Promise<CarteiraResponseDto> {
    const carteira = await this.service.obterOuCriar(usuario.idUsuario);
    return {
      saldoDisponivel: carteira.saldoDisponivel.toFixed(2),
      saldoBloqueado: carteira.saldoBloqueado.toFixed(2),
      status: carteira.status,
    };
  }
}
