import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RankingGeralItemDto {
  @ApiProperty({ example: 1 })
  posicao: number;

  @ApiProperty({ example: 30157355 })
  timeId: number;

  @ApiProperty({ example: 'Chute de ouro C01' })
  nomeTime: string;

  @ApiPropertyOptional({ nullable: true, example: 'Cartoleiro' })
  nomeCartoleiro: string | null;

  @ApiPropertyOptional({ nullable: true })
  escudoUrl: string | null;

  @ApiProperty({ example: 81.5 })
  pontuacao: number;

  @ApiProperty({ enum: ['PARCIAL', 'FINAL'] })
  status: 'PARCIAL' | 'FINAL';
}

export class RankingGeralResponseDto {
  @ApiProperty({ example: 2026 })
  temporada: number;

  @ApiProperty({ example: 25 })
  rodada: number;

  @ApiProperty({ example: 5234 })
  total: number;

  @ApiProperty({ type: [RankingGeralItemDto] })
  ranking: RankingGeralItemDto[];

  @ApiProperty({ example: { pagina: 1, limite: 20, total: 523, totalPaginas: 27 } })
  paginacao: { pagina: number; limite: number; total: number; totalPaginas: number };
}
