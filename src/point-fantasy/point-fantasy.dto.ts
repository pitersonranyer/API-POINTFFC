import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class FantasyPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}
export class CaptureCatalogDto {
  @IsInt() @Min(2000) @Max(65535) temporada: number;
  @IsInt() @Min(1) @Max(38) rodada: number;
  // Explicit version makes retries idempotent; a new version must be deliberate.
  @IsInt() @Min(1) @Max(4294967295) versao: number;
}
export class CreateFantasyCompetitionDto {
  @IsInt() @Min(1) @Max(4294967295) catalogoId: number;
  @IsString() @MinLength(1) @MaxLength(255) @Matches(/\S/) nome: string;
  @IsIn(['FREE', 'PAGO']) tipoAcesso: 'FREE' | 'PAGO';
  @IsString() @Matches(/^\d{1,10}\.\d{2}$/) valorInscricao: string;
  @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/) inicioInscricao: string;
  @IsDateString({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/) fimInscricao: string;
  @IsOptional() @IsInt() @Min(1) @Max(4294967295) limiteEscalacoesUsuario?: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(4294967295, { each: true }) partidaIds: number[];
}
