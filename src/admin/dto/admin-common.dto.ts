import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

const integer = ({ value }: { value: unknown }): number =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;

export class AdminIdParamsDto {
  @ApiProperty({ minimum: 1 })
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(4294967295)
  id!: number;
}

export class AdminLigaIdParamsDto {
  @ApiProperty({ minimum: 1 })
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(4294967295)
  ligaId!: number;
}
