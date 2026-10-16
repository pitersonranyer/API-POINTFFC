import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CreateLineupDto, DuplicateLineupDto, LineupIdDto, LineupPageDto, LineupVersionDto, UpdateLineupDto } from './lineup.dto';
import { LineupService } from './lineup.service';

@ApiTags('point-fantasy/escalacoes')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('point-fantasy')
export class LineupController {
  constructor(private readonly service: LineupService) {}
  @Post('competicoes/:id/escalacoes')
  create(@AuthenticatedUser() user: Usuario, @Param() p: LineupIdDto, @Body() dto: CreateLineupDto) {
    return this.service.create(user.idUsuario, p.id, dto);
  }
  @Get('competicoes/:id/escalacoes/minhas')
  list(@AuthenticatedUser() user: Usuario, @Param() p: LineupIdDto, @Query() page: LineupPageDto) {
    return this.service.list(user.idUsuario, p.id, page);
  }
  @Get('escalacoes/:id')
  get(@AuthenticatedUser() user: Usuario, @Param() p: LineupIdDto) { return this.service.get(user.idUsuario, p.id); }
  @Patch('escalacoes/:id')
  update(@AuthenticatedUser() user: Usuario, @Param() p: LineupIdDto, @Body() dto: UpdateLineupDto) {
    return this.service.update(user.idUsuario, p.id, dto);
  }
  @Post('escalacoes/:id/duplicar')
  duplicate(@AuthenticatedUser() user: Usuario, @Param() p: LineupIdDto, @Body() dto: DuplicateLineupDto) {
    return this.service.duplicate(user.idUsuario, p.id, dto.versao, dto);
  }
  @Delete('escalacoes/:id')
  remove(@AuthenticatedUser() user: Usuario, @Param() p: LineupIdDto, @Query() dto: LineupVersionDto) {
    return this.service.remove(user.idUsuario, p.id, dto.versao);
  }
}
