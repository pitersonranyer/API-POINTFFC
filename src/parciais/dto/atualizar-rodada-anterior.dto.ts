import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AtualizarRodadaAnteriorQueryDto {
  @ApiPropertyOptional({ example: 2026, description: 'Se informada, deve coincidir com a temporada oficial do mercado' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'temporada deve ser um numero inteiro' })
  @Min(1, { message: 'temporada deve ser maior que zero' })
  @Max(9999, { message: 'temporada deve ter no maximo quatro digitos' })
  temporada?: number;
}

export class FalhaAtualizacaoParcialDto {
  @ApiProperty({ example: 30157355 })
  timeId: number;

  @ApiProperty({ example: 'Snapshot do time nao encontrado' })
  motivo: string;
}

export class AtualizarRodadaAnteriorResponseDto {
  @ApiProperty({ example: 2026 })
  temporada: number;

  @ApiProperty({ example: 24 })
  rodada: number;

  @ApiProperty({ example: 120 })
  timesCadastrados: number;

  @ApiProperty({ example: 115 })
  atualizados: number;

  @ApiProperty({ example: 2 })
  jaProcessados: number;

  @ApiProperty({ example: 3 })
  semSnapshot: number;

  @ApiProperty({ example: [123, 456], type: [Number] })
  timeIdsSemSnapshot: number[];

  @ApiProperty({ example: 2 })
  falhas: number;

  @ApiProperty({ type: [FalhaAtualizacaoParcialDto] })
  detalhesFalhas: FalhaAtualizacaoParcialDto[];
}
