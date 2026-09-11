import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FutebolCompeticaoResumoDto {
  @ApiProperty() codigo!: string;
  @ApiProperty() nome!: string;
}
export class FutebolCompeticaoResponseDto extends FutebolCompeticaoResumoDto {
  @ApiProperty() pais!: string;
  @ApiProperty({ type: String, nullable: true }) emblemaUrl!: string | null;
  @ApiProperty() temporadaAtual!: number;
}
export class FutebolTimeResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() externalId!: number;
  @ApiProperty() nome!: string;
  @ApiProperty({ type: String, nullable: true }) nomeCurto!: string | null;
  @ApiProperty({ type: String, nullable: true }) sigla!: string | null;
  @ApiProperty({ type: String, nullable: true }) escudoUrl!: string | null;
}
export class FutebolPlacarDto {
  @ApiProperty({ type: Number, nullable: true }) mandante!: number | null;
  @ApiProperty({ type: Number, nullable: true }) visitante!: number | null;
}
export class FutebolJogoResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() externalId!: number;
  @ApiProperty() temporada!: number;
  @ApiProperty({ type: Number, nullable: true }) rodada!: number | null;
  @ApiProperty({ type: String, nullable: true }) fase!: string | null;
  @ApiProperty({ type: String, nullable: true }) grupo!: string | null;
  @ApiProperty({ format: 'date-time' }) dataHoraUtc!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) vencedor!: string | null;
  @ApiProperty({ type: FutebolTimeResponseDto }) mandante!: FutebolTimeResponseDto;
  @ApiProperty({ type: FutebolTimeResponseDto }) visitante!: FutebolTimeResponseDto;
  @ApiProperty({ type: FutebolPlacarDto }) placar!: FutebolPlacarDto;
  @ApiProperty({ type: FutebolPlacarDto }) placarIntervalo!: FutebolPlacarDto;
}
export class FutebolJogosResponseDto {
  @ApiProperty({ type: FutebolCompeticaoResumoDto }) competicao!: FutebolCompeticaoResumoDto;
  @ApiProperty() temporada!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) rodada?: number | null;
  @ApiProperty() total!: number;
  @ApiProperty({ type: [FutebolJogoResponseDto] }) jogos!: FutebolJogoResponseDto[];
}
