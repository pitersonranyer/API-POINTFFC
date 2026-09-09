import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class CriarRecargaPixDto {
  @ApiProperty({ example: '10.00', description: 'Valor decimal em reais, informado como texto' })
  @IsString()
  @MaxLength(13)
  @Matches(/^\d+(\.\d{1,2})?$/)
  valor!: string;
}
