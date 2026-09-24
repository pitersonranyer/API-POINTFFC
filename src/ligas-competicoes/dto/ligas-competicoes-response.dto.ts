import { ApiProperty } from '@nestjs/swagger';
import { CompeticaoLigaStatus, CompeticaoTipoAcesso, LigaTipo, PremiacaoCompeticaoTipo } from '@prisma/client';

export class ModalidadeResumoDto {
  @ApiProperty() codigo!: string;
  @ApiProperty() nome!: string;
}

export class LigaResumoDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: String, nullable: true }) imagemUrl!: string | null;
}

export class LigaResponseDto extends LigaResumoDto {
  @ApiProperty({ type: String, nullable: true }) descricao!: string | null;
  @ApiProperty({ enum: LigaTipo }) tipo!: LigaTipo;
  @ApiProperty({ type: [ModalidadeResumoDto] }) modalidades!: ModalidadeResumoDto[];
}

export class CompeticaoResumoDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: String, nullable: true }) descricao!: string | null;
  @ApiProperty({ enum: CompeticaoTipoAcesso }) tipoAcesso!: CompeticaoTipoAcesso;
  @ApiProperty({ type: Number }) valorInscricao!: number;
  @ApiProperty({ type: Number, nullable: true }) rodadaInicio!: number | null;
  @ApiProperty({ type: Number, nullable: true }) rodadaFim!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) inicioInscricao!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) fimInscricao!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) dataInicio!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) dataFim!: string | null;
  @ApiProperty({ type: Number, nullable: true }) limiteTimesUsuario!: number | null;
  @ApiProperty({ type: Number, nullable: true }) limiteParticipantes!: number | null;
  @ApiProperty({ enum: CompeticaoLigaStatus }) status!: CompeticaoLigaStatus;
  @ApiProperty() destaque!: boolean;
  @ApiProperty({ type: ModalidadeResumoDto }) modalidade!: ModalidadeResumoDto;
}

export class CompeticaoCardDto extends CompeticaoResumoDto {
  @ApiProperty({ description: 'Inscricoes ATIVA e FINALIZADA; exclui CANCELADA.' }) quantidadeInscritos!: number;
  @ApiProperty({ type: String, nullable: true, example: '1234.56', description: 'BRL decimal derivado, nao persistido. PAGO: inscritos validos x entrada menos taxa. FREE: premios fixos configurados, ou null.' })
  premiacaoEmDisputa!: string | null;
}

export class PremiacaoResumoDto {
  @ApiProperty() posicaoInicio!: number;
  @ApiProperty() posicaoFim!: number;
  @ApiProperty({ enum: PremiacaoCompeticaoTipo }) tipoPremiacao!: PremiacaoCompeticaoTipo;
  @ApiProperty({ type: Number, nullable: true }) valor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) percentual!: number | null;
  @ApiProperty() ordem!: number;
}

export class CompeticaoDetalheDto extends CompeticaoResumoDto {
  @ApiProperty({ type: LigaResumoDto }) liga!: LigaResumoDto;
  @ApiProperty() quantidadeInscritos!: number;
  @ApiProperty({ type: [PremiacaoResumoDto] }) premiacao!: PremiacaoResumoDto[];
}
