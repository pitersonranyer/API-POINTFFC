import { ApiProperty } from '@nestjs/swagger';

export class PendenciaEscalacaoDto {
  @ApiProperty() inscricaoId!: number;
  @ApiProperty() timeIdCartola!: number;
  @ApiProperty() nomeTime!: string;
}

export class DiagnosticoEscalacoesResponseDto {
  @ApiProperty() competicaoId!: number;
  @ApiProperty() rodada!: number;
  @ApiProperty() quantidadeInscricoesAtivas!: number;
  @ApiProperty() quantidadeEscalacoesEncontradas!: number;
  @ApiProperty() quantidadeEscalacoesPendentes!: number;
  @ApiProperty({ type: [PendenciaEscalacaoDto] }) pendencias!: PendenciaEscalacaoDto[];
}
