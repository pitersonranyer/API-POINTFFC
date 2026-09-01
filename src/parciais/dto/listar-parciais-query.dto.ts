import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';

export const MAX_PARTIAL_TEAM_IDS = 1000;

function parseTimeIds(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.split(',').map((item) => Number(item.trim()));
}

export class ListarParciaisQueryDto {
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

  @Transform(({ value }) => parseTimeIds(value))
  @IsArray({ message: 'timeIds deve ser uma lista separada por vírgulas' })
  @ArrayMinSize(1, { message: 'informe ao menos um timeId' })
  @ArrayMaxSize(MAX_PARTIAL_TEAM_IDS, { message: `o limite é de ${MAX_PARTIAL_TEAM_IDS} IDs por requisição` })
  @ArrayUnique({ message: 'timeIds não pode conter IDs duplicados' })
  @IsInt({ each: true, message: 'cada timeId deve ser um número inteiro' })
  @Min(1, { each: true, message: 'cada timeId deve ser maior que zero' })
  @Max(4294967295, { each: true, message: 'cada timeId excede o limite suportado' })
  timeIds: number[];
}
