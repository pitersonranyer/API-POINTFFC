import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CarteiraService } from './carteira.service';
import { CarteiraResponseDto } from './dto/carteira-response.dto';
import { ExtratoQueryDto } from './dto/extrato-query.dto';
import { ExtratoResponseDto } from './dto/extrato-response.dto';

@ApiTags('carteira')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('carteira')
export class CarteiraController {
  constructor(private readonly service: CarteiraService) {}

  @Get('extrato')
  @ApiOkResponse({ type: ExtratoResponseDto })
  consultarExtrato(
    @AuthenticatedUser() usuario: Usuario,
    @Query() query: ExtratoQueryDto,
  ): Promise<ExtratoResponseDto> {
    return this.service.consultarExtratoPaginado(usuario.idUsuario, query.page, query.limit);
  }

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
