import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminDashboardFinanceiroService } from './admin-dashboard-financeiro.service';
import { DashboardFinanceiroQueryDto, DashboardFinanceiroResponseDto } from './dto/admin-dashboard-financeiro.dto';

@ApiTags('admin')
@ApiBearerAuth('jwt')
@ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Acesso exclusivo para PLATFORM_ADMIN ativo' })
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/dashboard-financeiro')
export class AdminDashboardFinanceiroController {
  constructor(private readonly dashboard: AdminDashboardFinanceiroService) {}

  @Get()
  @ApiOperation({ summary: 'Valores previstos/nominais, sem confirmacao de pagamento',
    description: 'Filtros combinados por AND. Totalizadores abrangem todas as competicoes filtradas. Taxa fixa por inscricao; premio fixo por posicao. Taxa ausente equivale a zero. Arredondamento HALF_UP por taxa e premio, em centavos.' })
  @ApiOkResponse({ type: DashboardFinanceiroResponseDto })
  @ApiBadRequestResponse({ description: 'Filtros ou paginacao invalidos' })
  @ApiConflictResponse({ description: 'Configuracao financeira legada invalida; corrigir a competicao indicada' })
  consultar(@Query() query: DashboardFinanceiroQueryDto): Promise<DashboardFinanceiroResponseDto> {
    return this.dashboard.consultar(query);
  }
}
