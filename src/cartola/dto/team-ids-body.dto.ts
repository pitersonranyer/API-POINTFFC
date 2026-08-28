import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Min } from 'class-validator';

function normalizeIds(value: unknown): unknown {
  const fromString = typeof value === 'string';
  const items = fromString ? value.split(';').map((item) => item.trim()).filter(Boolean) : value;
  if (!Array.isArray(items)) return value;
  const numbers = items.map((item) => fromString ? Number(item) : typeof item === 'number' ? item : Number.NaN);
  return [...new Set(numbers)];
}

export class TeamIdsBodyDto {
  @Transform(({ value }) => normalizeIds(value))
  @IsArray({ message: 'timeIds deve ser uma lista de números ou uma string separada por ponto e vírgula' })
  @ArrayMinSize(1, { message: 'informe ao menos um timeId' })
  @ArrayMaxSize(50, { message: 'o limite é de 50 IDs por requisição' })
  @IsInt({ each: true, message: 'cada timeId deve ser um número inteiro' })
  @Min(1, { each: true, message: 'cada timeId deve ser maior que zero' })
  timeIds: number[];
}
