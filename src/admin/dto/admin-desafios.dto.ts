import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { DesafioStatus, DesafioTipoAcesso } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class CriarAdminDesafioDto {
  @ApiProperty() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(255)
  nome!: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString()
  descricao?: string | null;

  @ApiProperty({ enum: DesafioTipoAcesso }) @IsEnum(DesafioTipoAcesso)
  tipoAcesso!: DesafioTipoAcesso;

  @ApiProperty({ example: '2.00', description: 'Reais como texto decimal ou numero, ate duas casas e dez digitos inteiros',
    oneOf: [{ type: 'string', pattern: '^\\d{1,10}(\\.\\d{1,2})?$' }, { type: 'number', minimum: 0, maximum: 9999999999.99, multipleOf: 0.01 }] })
  @Transform(({ value }) => typeof value === 'number' && Number.isFinite(value) ? String(value) : value)
  @IsString() @Matches(/^\d{1,10}(\.\d{1,2})?$/)
  valorInscricao!: string;

  // Omissao e permitida; null e valores explicitos invalidos continuam rejeitados.
  // IsOptional tambem ignoraria null, alterando o contrato legado.
  @ApiPropertyOptional({ format: 'date-time', deprecated: true }) @ValidateIf((_o, value) => value !== undefined) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  inicioInscricao?: string;

  @ApiPropertyOptional({ format: 'date-time', deprecated: true }) @ValidateIf((_o, value) => value !== undefined) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  fimInscricao?: string;

  @ApiPropertyOptional({ format: 'date-time', deprecated: true }) @ValidateIf((_o, value) => value !== undefined) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  dataInicio?: string;

  @ApiPropertyOptional({ format: 'date-time', deprecated: true }) @ValidateIf((_o, value) => value !== undefined) @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  dataFim?: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: 4294967295 })
  @IsOptional() @IsInt() @Min(1) @Max(4294967295)
  limiteParticipantes?: number | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 4294967295, default: 1 })
  @ValidateIf((_o, value) => value !== undefined) @IsInt() @Min(1) @Max(4294967295)
  limiteInscricoesPorUsuario?: number;
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
