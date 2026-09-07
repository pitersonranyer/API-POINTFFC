import { Controller, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RoundParamsDto } from '../cartola/dto/round-params.dto';
import { RoundProcessingService } from './round-processing.service';

export class ReprocessarParciaisQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  temporada: number;
}

@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/rodadas')
export class AdminRoundsController {
  constructor(private readonly processing: RoundProcessingService) {}

  @Post(':rodada/reprocessar-parciais')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recalcula todos os snapshots com o envelope persistido, sem consolidar' })
  @ApiQuery({ name: 'temporada', required: true, type: Number })
  reprocessar(@Param() params: RoundParamsDto, @Query() query: ReprocessarParciaisQueryDto) {
    return this.processing.reprocessarParciais(params.rodada, query.temporada);
  }
}
