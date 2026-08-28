import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class RoundParamsDto {
  @Type(() => Number)
  @IsInt({ message: 'rodada deve ser um número inteiro' })
  @Min(1, { message: 'rodada deve ser no mínimo 1' })
  @Max(38, { message: 'rodada deve ser no máximo 38' })
  rodada: number;
}
