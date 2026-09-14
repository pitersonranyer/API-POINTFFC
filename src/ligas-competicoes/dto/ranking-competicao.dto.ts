import { ApiProperty } from '@nestjs/swagger';

export class RankingCompeticaoItemDto {
  @ApiProperty() inscricaoId!: number;
  @ApiProperty() timeIdCartola!: number;
  @ApiProperty() nomeTime!: string;
  @ApiProperty({ type: String, nullable: true }) nomeCartoleiro!: string | null;
  @ApiProperty({ type: String, nullable: true }) escudoUrl!: string | null;
  @ApiProperty({ type: Number, nullable: true }) pontuacao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicaoAnterior!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premioApurado!: number | null;
}

export class RankingCompeticaoResponseDto {
  @ApiProperty() competicaoId!: number;
  @ApiProperty() nomeCompeticao!: string;
  @ApiProperty() quantidadeParticipantes!: number;
  @ApiProperty({ type: [RankingCompeticaoItemDto] }) ranking!: RankingCompeticaoItemDto[];
}
