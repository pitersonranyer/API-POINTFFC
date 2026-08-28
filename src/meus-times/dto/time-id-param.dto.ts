import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class TimeIdParamDto {
  @Type(() => Number)
  @IsInt({ message: 'timeId deve ser um numero inteiro' })
  @Min(1, { message: 'timeId deve ser maior que zero' })
  timeId: number;
}
