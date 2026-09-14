import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CompeticaoLigaStatus } from '@prisma/client';

const integer = ({ value }: { value: unknown }) => typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;

export class LigaSlugParamsDto {
  @ApiProperty({ example: 'point-ffc' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug invalido' })
  slug!: string;
}

export class CompeticaoIdParamsDto {
  @ApiProperty({ minimum: 1 })
  @Transform(integer) @IsInt() @Min(1) @Max(4294967295)
  id!: number;
}

export class ListarCompeticoesQueryDto {
  @ApiPropertyOptional({ example: 'RODADA' })
  @IsOptional() @Matches(/^[A-Z0-9_]{1,50}$/)
  modalidade?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 255 })
  @IsOptional() @Transform(integer) @IsInt() @Min(1) @Max(255)
  rodada?: number;

  @ApiPropertyOptional({ enum: CompeticaoLigaStatus })
  @IsOptional() @IsIn(Object.values(CompeticaoLigaStatus))
  status?: CompeticaoLigaStatus;
}
