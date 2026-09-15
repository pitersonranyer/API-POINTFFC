import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class RankingGeralQueryDto {
  @Type(() => Number)
  @IsInt({ message: 'temporada deve ser um número inteiro' })
  @Min(1, { message: 'temporada deve ser maior que zero' })
  @Max(9999, { message: 'temporada deve ter no máximo quatro dígitos' })
  temporada: number;

  @Type(() => Number)
  @IsInt({ message: 'rodada deve ser um número inteiro' })
  @Min(1, { message: 'rodada deve estar entre 1 e 38' })
  @Max(38, { message: 'rodada deve estar entre 1 e 38' })
  rodada: number;

  @Type(() => Number)
  @IsInt({ message: 'limit deve ser um número inteiro' })
  @Min(1, { message: 'limit deve estar entre 1 e 100' })
  @Max(100, { message: 'limit deve estar entre 1 e 100' })
  limit = 15;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  nomeTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  nomeCartoleiro?: string;
}
