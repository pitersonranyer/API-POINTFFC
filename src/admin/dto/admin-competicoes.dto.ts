import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { CompeticaoLigaStatus, CompeticaoTipoAcesso, CompeticaoTipoTaxaPlataforma } from '@prisma/client';
import { IsBoolean, IsDate, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown => typeof value === 'string' ? value.trim() : value;

export class CriarAdminCompeticaoDto {
  @ApiProperty({ minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  ligaModalidadeId!: number;

  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(255)
  nome!: string;

  @ApiProperty() @Transform(trim) @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(255)
  slug!: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString()
  descricao?: string | null;

  @ApiProperty({ enum: CompeticaoTipoAcesso }) @IsEnum(CompeticaoTipoAcesso)
  tipoAcesso!: CompeticaoTipoAcesso;

  @ApiProperty({ minimum: 0 }) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  valorInscricao!: number;

  @ApiPropertyOptional({ enum: CompeticaoTipoTaxaPlataforma, nullable: true }) @IsOptional() @IsEnum(CompeticaoTipoTaxaPlataforma)
  tipoTaxaPlataforma?: CompeticaoTipoTaxaPlataforma | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  valorTaxaPlataforma?: number | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(255)
  rodadaInicio?: number | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(255)
  rodadaFim?: number | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) @IsOptional() @Type(() => Date) @ValidateIf((_o, value) => value !== null) @IsDate()
  dataInicio?: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) @IsOptional() @Type(() => Date) @ValidateIf((_o, value) => value !== null) @IsDate()
  dataFim?: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) @IsOptional() @Type(() => Date) @ValidateIf((_o, value) => value !== null) @IsDate()
  inicioInscricao?: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) @IsOptional() @Type(() => Date) @ValidateIf((_o, value) => value !== null) @IsDate()
  fimInscricao?: Date | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1)
  limiteTimesUsuario?: number | null;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1)
  limiteParticipantes?: number | null;

  @ApiPropertyOptional({ enum: CompeticaoLigaStatus, default: CompeticaoLigaStatus.RASCUNHO }) @IsOptional() @IsEnum(CompeticaoLigaStatus)
  status?: CompeticaoLigaStatus;

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean()
  visivelApp?: boolean;

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean()
  destaque?: boolean;
}

export class AtualizarAdminCompeticaoDto extends PartialType(CriarAdminCompeticaoDto) {}

export class ListarAdminCompeticoesQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  pagina = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limite = 20;

  @ApiPropertyOptional({ description: 'ID da liga' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  liga?: number;

  @ApiPropertyOptional({ description: 'ID da modalidade' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  modalidade?: number;

  @ApiPropertyOptional({ enum: CompeticaoLigaStatus }) @IsOptional() @IsEnum(CompeticaoLigaStatus)
  status?: CompeticaoLigaStatus;

  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value) @IsBoolean()
  visivel?: boolean;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(255)
  busca?: string;
}
