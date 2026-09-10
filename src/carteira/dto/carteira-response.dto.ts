import { ApiProperty } from '@nestjs/swagger';
import { CarteiraStatus } from '@prisma/client';

export class CarteiraResponseDto {
  @ApiProperty({ type: String, example: '0.00', description: 'Saldo disponível em reais, com duas casas decimais' })
  saldoDisponivel!: string;

  @ApiProperty({ type: String, example: '0.00', description: 'Saldo bloqueado em reais, com duas casas decimais' })
  saldoBloqueado!: string;

  @ApiProperty({ enum: CarteiraStatus, example: CarteiraStatus.ATIVA })
  status!: CarteiraStatus;
}
