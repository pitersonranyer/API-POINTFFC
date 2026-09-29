import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DesafioResultado, DesafioTipoAcesso } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

const integer = ({ value }: { value: unknown }): number =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;

export class DesafioIdParamsDto {
  @ApiProperty({ minimum: 1, maximum: 4294967295 })
  @Transform(integer) @IsInt() @Min(1) @Max(4294967295)
  id!: number;
}

export class DesafioPartidaParamsDto extends DesafioIdParamsDto {
  @ApiProperty({ minimum: 1, maximum: 4294967295, description: 'ID interno da partida no Desafio' })
  @Transform(integer) @IsInt() @Min(1) @Max(4294967295)
  partidaId!: number;
}

export class ListarDesafiosQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Transform(integer) @IsInt() @Min(1) @Max(4294967295)
  pagina = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional() @Transform(integer) @IsInt() @Min(1) @Max(100)
  limite = 20;

  @ApiPropertyOptional({ enum: DesafioTipoAcesso })
  @IsOptional() @IsEnum(DesafioTipoAcesso)
  tipoAcesso?: DesafioTipoAcesso;
}

export class SalvarDesafioPalpiteDto {
  @ApiProperty({ enum: DesafioResultado })
  @IsEnum(DesafioResultado)
  palpite!: DesafioResultado;
}
