import { ApiProperty } from '@nestjs/swagger';
import { DesafioInscricaoStatus, DesafioTipoAcesso } from '@prisma/client';

// A confirmacao nao recebe identidade, preco, palpites ou dados financeiros do cliente.
export class ParticiparDesafioDto {}

export class MinhaDesafioInscricaoDto {
  @ApiProperty() id!: number;
  @ApiProperty() desafioId!: number;
  @ApiProperty({ enum: DesafioInscricaoStatus }) status!: DesafioInscricaoStatus;
  @ApiProperty({ example: '2.00', description: 'Snapshot da entrada, em BRL' }) valorInscricao!: string;
  @ApiProperty({ format: 'date-time' }) dataInscricao!: string;
}

export class DesafioParticipacaoDto {
  @ApiProperty({ type: MinhaDesafioInscricaoDto }) inscricao!: MinhaDesafioInscricaoDto;
  @ApiProperty({ enum: DesafioTipoAcesso }) tipoAcesso!: DesafioTipoAcesso;
  @ApiProperty({ example: '2.00', description: 'Valor cobrado na inscricao original; replay nao cobra novamente' })
  valorCobrado!: string;
}

export class DesafioSaldoInsuficienteDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ example: 'SALDO_INSUFICIENTE' }) code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ example: '1.00' }) saldoDisponivel!: string;
  @ApiProperty({ example: '2.00' }) valorNecessario!: string;
  @ApiProperty({ example: '1.00' }) valorFaltante!: string;
  @ApiProperty({ example: 'BRL' }) moeda!: string;
}
