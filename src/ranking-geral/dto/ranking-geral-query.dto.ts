import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

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
}
