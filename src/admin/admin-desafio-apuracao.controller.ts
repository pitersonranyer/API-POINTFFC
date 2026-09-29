import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AdminIdParamsDto } from './dto/admin-common.dto';
import { AcaoAdminDesafioDto } from './dto/admin-desafios.dto';
import { AdminDesafioApuracaoService } from './admin-desafio-apuracao.service';

@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/desafios')
export class AdminDesafioApuracaoController {
  constructor(private readonly service: AdminDesafioApuracaoService) {}

  @Post(':id/apurar')
  @ApiOperation({ summary: 'Apura resultados de 90 minutos via football-data.org; permite reexecucao e correcao' })
  @ApiCreatedResponse({ description: 'Apuracao concluida; inclui contagens e pendencias sem placar seguro' })
  apurar(@Param() params: AdminIdParamsDto, @Body() dto: AcaoAdminDesafioDto) {
    void dto;
    return this.service.apurar(params.id);
  }
}
