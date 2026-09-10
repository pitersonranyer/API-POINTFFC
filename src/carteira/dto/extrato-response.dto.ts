import { ApiProperty } from '@nestjs/swagger';
import { MovimentacaoCarteiraOrigem, MovimentacaoCarteiraStatus, MovimentacaoCarteiraTipo } from '@prisma/client';

export class ExtratoItemDto {
  @ApiProperty()
  id!: number;

  @ApiProperty({ enum: MovimentacaoCarteiraTipo })
  tipo!: MovimentacaoCarteiraTipo;

  @ApiProperty({ enum: MovimentacaoCarteiraOrigem })
  origem!: MovimentacaoCarteiraOrigem;

  @ApiProperty({ type: String, example: '10.00' })
  valor!: string;

  @ApiProperty({ type: String, example: '20.00' })
  saldoAnterior!: string;

  @ApiProperty({ type: String, example: '30.00' })
  saldoPosterior!: string;

  @ApiProperty({ type: String, nullable: true })
  descricao!: string | null;

  @ApiProperty({ enum: MovimentacaoCarteiraStatus })
  status!: MovimentacaoCarteiraStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  criadoEm!: string;
}

export class ExtratoResponseDto {
  @ApiProperty({ type: [ExtratoItemDto] })
  items!: ExtratoItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 35 })
  total!: number;

  @ApiProperty({ example: 2 })
  totalPages!: number;
}
