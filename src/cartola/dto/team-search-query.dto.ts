import { Transform } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';

export class TeamSearchQueryDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString({ message: 'nome deve ser um texto' })
  @MinLength(2, { message: 'nome deve ter no mínimo 2 caracteres' })
  nome: string;
}
