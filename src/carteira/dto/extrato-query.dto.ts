import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

const inteiro = ({ value }: { value: unknown }): number =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;

export class ExtratoQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, type: Number })
  @Transform(inteiro)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, type: Number })
  @Transform(inteiro)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
