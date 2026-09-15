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
  @ApiProperty({ type: Number, nullable: true, description: 'ID do clube Cartola, disponível somente no contexto BSA' }) cartolaClubeId!: number | null;
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

export class FutebolRodadaReferenciaResponseDto extends FutebolJogosResponseDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Referência inferida pelo bloco coletivo da fase/rodada. rodada é um alias temporário.' }) rodadaReferencia!: number | null;
  @ApiProperty({ type: String, nullable: true }) faseReferencia!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Última rodada integralmente resolvida nos dados disponíveis, até a referência.' }) ultimaRodadaConcluida!: number | null;
  @ApiProperty({ type: String, nullable: true }) faseUltimaRodadaConcluida!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Sucessora da referência entre as etapas com quantidade suficiente de partidas.' }) proximaRodada!: number | null;
  @ApiProperty({ type: String, nullable: true }) faseProximaRodada!: string | null;
  @ApiProperty({ type: [FutebolJogoResponseDto], description: 'Jogos não resolvidos de etapas anteriores; cancelados não são pendências jogáveis.' }) partidasPendentes!: FutebolJogoResponseDto[];
}

export class FutebolCompeticaoJogoDto extends FutebolCompeticaoResumoDto {
  @ApiProperty() id!: number;
  @ApiProperty({ type: String, nullable: true }) emblemaUrl!: string | null;
}

export class FutebolJogoDiaResponseDto extends FutebolJogoResponseDto {
  @ApiProperty({ type: FutebolCompeticaoJogoDto }) competicao!: FutebolCompeticaoJogoDto;
}

export class FutebolJogosHojeResponseDto {
  @ApiProperty({ example: '2026-09-15', description: 'Dia considerado em America/Sao_Paulo' }) data!: string;
  @ApiProperty({ enum: ['America/Sao_Paulo'] }) timezone!: string;
  @ApiProperty() total!: number;
  @ApiProperty({ type: [FutebolJogoDiaResponseDto] }) jogos!: FutebolJogoDiaResponseDto[];
}
