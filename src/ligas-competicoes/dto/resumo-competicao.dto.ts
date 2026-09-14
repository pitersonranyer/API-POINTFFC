import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { CompeticaoResumoDto, LigaResumoDto, ModalidadeResumoDto, PremiacaoResumoDto } from './ligas-competicoes-response.dto';
import { MinhaInscricaoDto } from './inscricoes-competicao.dto';
import { MotivoBloqueio } from '../inscricoes-competicao.service';

export class CompeticaoDadosResumoDto extends OmitType(CompeticaoResumoDto, ['modalidade'] as const) {}
export class MinhaInscricaoResumoDto extends OmitType(MinhaInscricaoDto, ['valorInscricao'] as const) {}

export class InscritosResumoDto {
  @ApiProperty() quantidade!: number;
}

export class UsuarioCompeticaoResumoDto {
  @ApiProperty() quantidadeTimesInscritos!: number;
  @ApiProperty({ type: Number, nullable: true }) limiteTimesUsuario!: number | null;
  @ApiProperty() podeInscrever!: boolean;
  @ApiProperty({ type: String, nullable: true }) motivoBloqueio!: MotivoBloqueio | null;
  @ApiProperty({ type: Number, nullable: true }) melhorPosicaoUsuario!: number | null;
  @ApiProperty({ type: Number, nullable: true }) melhorPontuacaoUsuario!: number | null;
}

export class ResumoCompeticaoResponseDto {
  @ApiProperty({ type: CompeticaoDadosResumoDto }) competicao!: CompeticaoDadosResumoDto;
  @ApiProperty({ type: LigaResumoDto }) liga!: LigaResumoDto;
  @ApiProperty({ type: ModalidadeResumoDto }) modalidade!: ModalidadeResumoDto;
  @ApiProperty({ type: InscritosResumoDto }) inscritos!: InscritosResumoDto;
  @ApiProperty({ type: [PremiacaoResumoDto] }) premiacao!: PremiacaoResumoDto[];
  @ApiPropertyOptional({ type: UsuarioCompeticaoResumoDto }) usuario?: UsuarioCompeticaoResumoDto;
  @ApiPropertyOptional({ type: [MinhaInscricaoResumoDto] }) minhasInscricoes?: MinhaInscricaoResumoDto[];
}
