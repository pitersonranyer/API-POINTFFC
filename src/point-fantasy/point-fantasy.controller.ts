import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { LineupIdDto, LineupPageDto } from './lineups/lineup.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaptureCatalogDto, CloseFantasyCompetitionDto, CreateFantasyCompetitionDto, FantasyPageDto } from './point-fantasy.dto';
import { PointFantasyService } from './point-fantasy.service';

@ApiTags('point-fantasy')
@Controller('point-fantasy')
export class PointFantasyController {
  constructor(private readonly service: PointFantasyService) {}
  @Get('catalogos') catalogs(@Query() page: FantasyPageDto) { return this.service.catalogs(page); }
  @Get('catalogos/:id/atletas') athletes(@Param('id', ParseIntPipe) id: number, @Query() page: FantasyPageDto) { return this.service.athletes(id, page); }
  @Get('catalogos/:id/clubes') clubs(@Param('id', ParseIntPipe) id: number) { return this.service.references(id, 'clubes'); }
  @Get('catalogos/:id/posicoes') positions(@Param('id', ParseIntPipe) id: number) { return this.service.references(id, 'posicoes'); }
  @Get('competicoes') competitions(@Query() page: FantasyPageDto) { return this.service.competitions(page); }
  @Get('competicoes/:id/ranking')
  @UseGuards(OptionalJwtAuthGuard)
  @Header('Cache-Control', 'private, no-store')
  ranking(@Param() params: LineupIdDto, @Query() page: LineupPageDto, @AuthenticatedUser() user?: Usuario) {
    return this.service.ranking(params.id, page, user?.idUsuario);
  }
  @Get('competicoes/:id') competition(@Param('id', ParseIntPipe) id: number) { return this.service.competition(id); }
  @Get('competicoes/:id/partidas') async matches(@Param('id', ParseIntPipe) id: number) { return { items: (await this.service.competition(id)).partidas }; }
  @Get('competicoes/:id/atletas') eligible(@Param('id', ParseIntPipe) id: number, @Query() page: FantasyPageDto) { return this.service.eligible(id, page); }
}

@ApiTags('admin/point-fantasy')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/point-fantasy')
export class AdminPointFantasyController {
  constructor(private readonly service: PointFantasyService) {}
  @Post('catalogos/capturar') capture(@Body() dto: CaptureCatalogDto) { return this.service.capture(dto); }
  @Post('catalogos/:id/congelar') freeze(@Param('id', ParseIntPipe) id: number) { return this.service.freeze(id); }
  @Post('competicoes') create(@Body() dto: CreateFantasyCompetitionDto) { return this.service.createCompetition(dto); }
  @Get('competicoes/:id') detail(@Param('id', ParseIntPipe) id: number) { return this.service.competition(id, undefined, true); }
  @Post('competicoes/:id/publicar') publish(@Param('id', ParseIntPipe) id: number) { return this.service.publish(id); }
  @Post('competicoes/:id/fechar') close(@Param() params: LineupIdDto, @Body() dto: CloseFantasyCompetitionDto,
    @AuthenticatedUser() user: Usuario) { return this.service.closeCompetition(params.id, user.idUsuario, dto); }
}
