import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export const FORMATIONS = ['4-3-3', '4-4-2', '3-5-2', '3-4-3', '4-5-1', '5-3-2', '5-4-1'] as const;
export class LineupIdDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(4294967295) id: number;
}
export class LineupVersionDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(4294967294) versao: number;
}
export class LineupPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}
export class LineupSelectionDto {
  // IDs below always identify FantasyCatalogoAtleta.id, never Cartola external IDs.
  @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(11) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(4294967295, { each: true }) titulares?: number[];
  @IsOptional() @IsInt() @Min(1) @Max(4294967295) tecnico?: number | null;
  @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(5) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(4294967295, { each: true }) reservas?: number[];
  @IsOptional() @IsInt() @Min(1) @Max(4294967295) capitaoAtletaId?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(4294967295) reservaMagoAtletaId?: number | null;
}
export class CreateLineupDto extends LineupSelectionDto {
  @IsIn(FORMATIONS) formacao: string;
}
export class UpdateLineupDto extends LineupSelectionDto {
  @ValidateIf((_o, v) => v !== undefined) @IsIn(FORMATIONS) formacao?: string;
  @IsInt() @Min(1) @Max(4294967294) versao: number;
}
