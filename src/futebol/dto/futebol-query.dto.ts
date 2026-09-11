import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const FUTEBOL_STATUS = ['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'POSTPONED', 'SUSPENDED', 'CANCELLED', 'AWARDED'] as const;
const integer = ({ value }: { value: unknown }) => typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;
const datePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/;

export class FutebolCodigoParamsDto {
  @ApiProperty({ example: 'BSA', maxLength: 10 })
  @Matches(/^[A-Z0-9]{1,10}$/)
  codigo!: string;
}
export class FutebolRodadaParamsDto extends FutebolCodigoParamsDto {
  @ApiProperty({ minimum: 1, maximum: 65535 })
  @Transform(integer) @IsInt() @Min(1) @Max(65535)
  rodada!: number;
}
export class FutebolJogosQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 65535 })
  @IsOptional() @Transform(integer) @IsInt() @Min(1) @Max(65535)
  temporada?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 65535 })
  @IsOptional() @Transform(integer) @IsInt() @Min(1) @Max(65535)
  rodada?: number;

  @ApiPropertyOptional({ enum: FUTEBOL_STATUS })
  @IsOptional() @IsIn(FUTEBOL_STATUS)
  status?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (início do dia UTC) ou ISO 8601 com fuso' })
  @IsOptional() @Matches(datePattern) @IsDateString({ strict: true })
  dataInicio?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (dia inteiro UTC) ou ISO 8601 com fuso, inclusivo' })
  @IsOptional() @Matches(datePattern) @IsDateString({ strict: true })
  dataFim?: string;
}
