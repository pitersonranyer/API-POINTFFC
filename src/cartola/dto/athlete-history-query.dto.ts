import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AthleteHistoryParamsDto {
  @ApiProperty({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  atletaId: number;
}

export class AthleteHistoryQueryDto {
  @ApiProperty({ minimum: 1, maximum: 65535, example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  temporada: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 38, description: 'Padrão: maior rodada CONSOLIDADA da temporada no banco.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(38)
  rodadaReferencia?: number;

  @ApiPropertyOptional({ enum: [5, 10], default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([5, 10])
  limite: number = 5;
}
