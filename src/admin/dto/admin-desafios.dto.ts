import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { DesafioStatus, DesafioTipoAcesso } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CriarAdminDesafioDto {
  @ApiProperty() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(255)
  nome!: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString()
  descricao?: string | null;

  @ApiProperty({ enum: DesafioTipoAcesso }) @IsEnum(DesafioTipoAcesso)
  tipoAcesso!: DesafioTipoAcesso;

  @ApiProperty({ example: '2.00', description: 'Reais como texto decimal, ate duas casas e dez digitos inteiros' })
  @IsString() @Matches(/^\d{1,10}(\.\d{1,2})?$/)
  valorInscricao!: string;

  @ApiProperty({ format: 'date-time' }) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  inicioInscricao!: string;

  @ApiProperty({ format: 'date-time' }) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  fimInscricao!: string;

  @ApiProperty({ format: 'date-time' }) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  dataInicio!: string;

  @ApiProperty({ format: 'date-time' }) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  dataFim!: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: 4294967295 })
  @IsOptional() @IsInt() @Min(1) @Max(4294967295)
  limiteParticipantes?: number | null;
}

// NULL so e permitido nos campos explicitamente opcionais do DTO de criacao.
export class AtualizarAdminDesafioDto extends PartialType(CriarAdminDesafioDto, { skipNullProperties: false }) {}

export class ListarAdminDesafiosQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  pagina = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limite = 20;

  @ApiPropertyOptional({ enum: DesafioStatus }) @IsOptional() @IsEnum(DesafioStatus)
  status?: DesafioStatus;

  @ApiPropertyOptional({ enum: DesafioTipoAcesso }) @IsOptional() @IsEnum(DesafioTipoAcesso)
  tipoAcesso?: DesafioTipoAcesso;
}

// Acoes nao recebem configuracao nem status no body.
export class AcaoAdminDesafioDto {}
