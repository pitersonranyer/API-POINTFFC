import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type ParcialLeituraStatus = 'PARCIAL' | 'FINAL' | 'AGUARDANDO' | 'NAO_ENCONTRADO';

export class ParcialTimeResponseDto {
  @ApiProperty({ example: 30157355 })
  timeId: number;

  @ApiPropertyOptional({ nullable: true, example: 'Chute de Ouro C01' })
  nomeTime: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Cartoleiro' })
  nomeCartoleiro: string | null;

  @ApiPropertyOptional({ nullable: true })
  escudoUrl: string | null;

  @ApiPropertyOptional({ nullable: true, example: 75.2 })
  pontuacao: number | null;

  @ApiProperty({ enum: ['PARCIAL', 'FINAL', 'AGUARDANDO', 'NAO_ENCONTRADO'] })
  status: ParcialLeituraStatus;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  atualizadoEm: Date | null;
}

export class ListaParciaisResponseDto {
  @ApiProperty({ example: 2026 })
  temporada: number;

  @ApiProperty({ example: 25 })
  rodada: number;

  @ApiProperty({ type: [ParcialTimeResponseDto] })
  parciais: ParcialTimeResponseDto[];
}
