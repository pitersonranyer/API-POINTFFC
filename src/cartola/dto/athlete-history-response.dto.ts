import { ApiProperty } from '@nestjs/swagger';
import { RodadaProcessamentoStatus } from '@prisma/client';

export class AthleteHistoryRoundDto {
  @ApiProperty() rodada: number;
  @ApiProperty({ enum: RodadaProcessamentoStatus, nullable: true,
    description: 'Estado global do processamento; não certifica independentemente a pontuação individual.' })
  statusRodada: RodadaProcessamentoStatus | null;
  @ApiProperty({ enum: ['PONTUADO', 'NAO_JOGOU', 'SEM_DADOS', 'DADO_INVALIDO'] })
  situacao: 'PONTUADO' | 'NAO_JOGOU' | 'SEM_DADOS' | 'DADO_INVALIDO';
  @ApiProperty({ type: String, nullable: true }) motivo: string | null;
  @ApiProperty({ type: Number, nullable: true }) pontuacao: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) entrouEmCampo: boolean | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' }, nullable: true })
  scouts: Record<string, number> | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) consolidadoEm: string | null;
  @ApiProperty({ enum: ['AUSENTE', 'SEM_JSON', 'VALIDO', 'INCOMPLETO', 'INVALIDO'],
    description: 'VALIDO significa envelope estruturalmente válido; não comprova cobertura de todos os atletas.' })
  estadoSnapshot: 'AUSENTE' | 'SEM_JSON' | 'VALIDO' | 'INCOMPLETO' | 'INVALIDO';
  @ApiProperty({ description: 'Registro presente com estado diferente de CONSOLIDADA; não entra nas métricas.' })
  parcial: boolean;
}

export class AthleteHistoryExtremeDto {
  @ApiProperty() pontuacao: number;
  @ApiProperty() rodada: number;
}

export class AthleteHistoryIndicatorsDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Média das pontuações válidas consolidadas disponíveis de 1 até a referência.' })
  mediaGeralDisponivel: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Janela fixa de até cinco rodadas; divisor é amostraUltimas5.' })
  mediaUltimas5: number | null;
  @ApiProperty({ type: AthleteHistoryExtremeDto, nullable: true }) maior: AthleteHistoryExtremeDto | null;
  @ApiProperty({ type: AthleteHistoryExtremeDto, nullable: true }) menor: AthleteHistoryExtremeDto | null;
  @ApiProperty({ type: Number, nullable: true,
    description: 'Desvio padrão populacional; null com n < 2. Menor dispersão não implica melhor desempenho. Estatísticas arredondadas a duas casas, sem arredondamento intermediário.' })
  desvioPadrao: number | null;
  @ApiProperty() amostraGeral: number;
  @ApiProperty() amostraUltimas5: number;
}

export class AthleteHistoryCoverageDto {
  @ApiProperty({ type: [Number], description: 'Sem registro ou sem JSON de pontuados, de 1 até a referência.' })
  rodadasSemSnapshot: number[];
  @ApiProperty({ type: [Number], description: 'Rodadas sem pontuação individual válida, incluindo lacunas e dados inválidos.' })
  rodadasSemPontuacaoDoAtleta: number[];
  @ApiProperty({ type: [Number] }) rodadasParciais: number[];
  @ApiProperty({ type: [Number] }) rodadasComSnapshotInvalidoOuIncompleto: number[];
  @ApiProperty({ description: 'Todas as rodadas têm envelope válido consolidado. Não comprova completude individual nem participação.' })
  temporadaComSnapshotsCompletosAteReferencia: boolean;
}

export class AthleteHistoryResponseDto {
  @ApiProperty() atletaId: number;
  @ApiProperty() temporada: number;
  @ApiProperty() rodadaReferencia: number;
  @ApiProperty({ type: [AthleteHistoryRoundDto] }) historico: AthleteHistoryRoundDto[];
  @ApiProperty({ type: AthleteHistoryIndicatorsDto }) indicadores: AthleteHistoryIndicatorsDto;
  @ApiProperty({ type: AthleteHistoryCoverageDto }) cobertura: AthleteHistoryCoverageDto;
}
