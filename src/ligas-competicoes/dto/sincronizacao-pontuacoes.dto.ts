import { ApiProperty } from '@nestjs/swagger';

class PendenciaPontuacaoDto {
  @ApiProperty() inscricaoId!: number;
  @ApiProperty() timeIdCartola!: number;
  @ApiProperty() nomeTime!: string;
  @ApiProperty({ enum: ['TIME_RODADA_NAO_ENCONTRADO', 'PONTUACAO_INDISPONIVEL'] }) motivo!: string;
}

export class SincronizacaoPontuacoesResponseDto {
  @ApiProperty() competicaoId!: number;
  @ApiProperty() rodada!: number;
  @ApiProperty() quantidadeInscricoesAtivas!: number;
  @ApiProperty() quantidadeAtualizadas!: number;
  @ApiProperty() quantidadePendentes!: number;
  @ApiProperty({ type: [PendenciaPontuacaoDto] }) pendencias!: PendenciaPontuacaoDto[];
}
