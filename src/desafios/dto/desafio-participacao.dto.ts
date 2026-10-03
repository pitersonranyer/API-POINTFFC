import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DesafioInscricaoStatus, DesafioTipoAcesso } from '@prisma/client';
import { IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

// A confirmacao nao recebe identidade, preco, palpites ou dados financeiros do cliente.
export class ParticiparDesafioDto {
  @ApiPropertyOptional({ description: 'Cartela a efetivar; omissao confirma somente Palpite 1 (legado)' })
  @ValidateIf((_o, value) => value !== undefined) @IsInt() @Min(1) @Max(4294967295)
  inscricaoId?: number;
}

export class CriarDesafioCartelaDto {
  @ApiProperty({ description: 'Chave estavel por tentativa de nova cartela; reutilizar em retries', maxLength: 100 })
  @IsString() @MaxLength(100) @Matches(/^[a-zA-Z0-9_-]{1,100}$/)
  chaveIdempotencia!: string;
}

export class MinhaDesafioInscricaoDto {
  @ApiProperty() id!: number;
  @ApiProperty() desafioId!: number;
  @ApiProperty() numero!: number;
  @ApiProperty({ example: 'Palpite 1' }) nome!: string;
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
