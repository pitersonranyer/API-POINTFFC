import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminLigasService } from './admin-ligas.service';
import { AdminLigaIdParamsDto } from './dto/admin-common.dto';
import { AdminLigaDto, AdminLigaModalidadeDto } from './dto/admin-ligas.dto';

@ApiTags('admin')
@ApiBearerAuth('jwt')
@ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Acesso exclusivo para PLATFORM_ADMIN ativo' })
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/ligas')
export class AdminLigasController {
  constructor(private readonly ligas: AdminLigasService) {}

  @Get()
  @ApiOkResponse({ type: [AdminLigaDto] })
  listar(): Promise<AdminLigaDto[]> { return this.ligas.listar(); }

  @Get(':ligaId/modalidades')
  @ApiOkResponse({ type: [AdminLigaModalidadeDto] })
  @ApiNotFoundResponse({ description: 'Liga nao encontrada' })
  listarModalidades(@Param() params: AdminLigaIdParamsDto): Promise<AdminLigaModalidadeDto[]> {
    return this.ligas.listarModalidades(params.ligaId);
  }
}
