import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class TeamIdParamsDto {
  @Type(() => Number)
  @IsInt({ message: 'timeId deve ser um número inteiro' })
  @Min(1, { message: 'timeId deve ser maior que zero' })
  timeId: number;
}
