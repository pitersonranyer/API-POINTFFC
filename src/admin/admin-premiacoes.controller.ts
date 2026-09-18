import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminPremiacoesService } from './admin-premiacoes.service';
import { AdminIdParamsDto } from './dto/admin-common.dto';
import { AdminPremiacaoResponseDto, SubstituirAdminPremiacoesDto } from './dto/admin-premiacoes.dto';

@ApiTags('admin')
@ApiBearerAuth('jwt')
@ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Acesso exclusivo para PLATFORM_ADMIN ativo' })
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/competicoes')
export class AdminPremiacoesController {
  constructor(private readonly premiacoes: AdminPremiacoesService) {}

  @Get(':id/premiacoes')
  @ApiOkResponse({ type: [AdminPremiacaoResponseDto] })
  @ApiNotFoundResponse({ description: 'Competicao nao encontrada' })
  listar(@Param() params: AdminIdParamsDto): Promise<AdminPremiacaoResponseDto[]> {
    return this.premiacoes.listar(params.id);
  }

  @Put(':id/premiacoes')
  @ApiOkResponse({ type: [AdminPremiacaoResponseDto] })
  substituir(@Param() params: AdminIdParamsDto, @Body() dto: SubstituirAdminPremiacoesDto): Promise<AdminPremiacaoResponseDto[]> {
    return this.premiacoes.substituir(params.id, dto.premiacoes);
  }
}
