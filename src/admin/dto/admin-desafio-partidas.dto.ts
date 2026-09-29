import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsDateString, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { AdminIdParamsDto } from './admin-common.dto';

export class PesquisarAdminFixturesDto {
  @ApiPropertyOptional({ example: '2026-10-03' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true })
  date?: string;

  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-07' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({ minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  league?: number;

  @ApiPropertyOptional({ minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  team?: number;

  @ApiPropertyOptional({ description: 'Ano de inicio da temporada; obrigatorio com league/team', example: 2026 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(9999)
  season?: number;
}

export class AdicionarAdminDesafioPartidaDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(4294967295)
  fixtureId!: number;
}

export class ReordenarAdminDesafioPartidasDto {
  @ApiProperty({ type: [Number], example: [14, 11, 13, 12] })
  @IsArray() @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(4294967295, { each: true })
  partidaIds!: number[];
}

export class AdminDesafioPartidaParamsDto extends AdminIdParamsDto {
  @ApiProperty({ minimum: 1 })
  @Transform(({ value }) => typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : NaN)
  @IsInt() @Min(1) @Max(4294967295)
  partidaId!: number;
}
