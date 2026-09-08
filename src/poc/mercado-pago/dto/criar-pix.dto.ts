import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

export class CriarPixDto {
  @ApiProperty({ example: 10, minimum: 0.01, maximum: 10000, description: 'Valor em reais, no máximo duas casas decimais. Limite da POC: R$ 10.000.' })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(10000)
  valor!: number;
}
