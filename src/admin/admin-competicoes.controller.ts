import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminCompeticoesService } from './admin-competicoes.service';
import { AtualizarAdminCompeticaoDto, CriarAdminCompeticaoDto, DuplicarAdminCompeticaoDto, ListarAdminCompeticoesQueryDto } from './dto/admin-competicoes.dto';
import { AdminIdParamsDto } from './dto/admin-common.dto';

@ApiTags('admin')
@ApiBearerAuth('jwt')
@ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Acesso exclusivo para PLATFORM_ADMIN ativo' })
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/competicoes')
export class AdminCompeticoesController {
  constructor(private readonly competicoes: AdminCompeticoesService) {}

  @Get()
  @ApiOkResponse({ description: 'Pagina de competicoes administrativas' })
  listar(@Query() query: ListarAdminCompeticoesQueryDto): Promise<Record<string, unknown>> {
    return this.competicoes.listar(query);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Detalhe administrativo da competicao' })
  @ApiNotFoundResponse({ description: 'Competicao nao encontrada' })
  buscar(@Param() params: AdminIdParamsDto): Promise<Record<string, unknown>> {
    return this.competicoes.buscar(params.id);
  }

  @Post()
  @ApiCreatedResponse({ description: 'Competicao criada' })
  criar(@Body() dto: CriarAdminCompeticaoDto): Promise<Record<string, unknown>> {
    return this.competicoes.criar(dto);
  }

  @Post(':id/duplicar')
  @ApiCreatedResponse({ description: 'Nova competicao criada a partir do modelo informado' })
  @ApiNotFoundResponse({ description: 'Competicao de origem nao encontrada' })
  duplicar(@Param() params: AdminIdParamsDto, @Body() dto: DuplicarAdminCompeticaoDto): Promise<Record<string, unknown>> {
    return this.competicoes.duplicar(params.id, dto);
  }

  @Patch(':id')
  @ApiOkResponse({ description: 'Competicao atualizada' })
  atualizar(@Param() params: AdminIdParamsDto, @Body() dto: AtualizarAdminCompeticaoDto): Promise<Record<string, unknown>> {
    return this.competicoes.atualizar(params.id, dto);
  }
}
