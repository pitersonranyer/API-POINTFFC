import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';
import { AdicionarTimeDto } from './adicionar-time.dto';

export class ImportarTimesDto {
  @ApiProperty({ type: [AdicionarTimeDto] })
  @IsArray({ message: 'times deve ser uma lista' })
  @ArrayMinSize(1, { message: 'informe ao menos um time' })
  @ArrayMaxSize(50, { message: 'o limite e de 50 times por importacao' })
  times: unknown[];
}
