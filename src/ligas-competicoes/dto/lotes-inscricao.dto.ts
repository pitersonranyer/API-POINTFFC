import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CompeticaoTipoAcesso, InscricaoTimeCompeticaoStatus } from '@prisma/client';
import { IsString, Matches, ValidateIf } from 'class-validator';
import { CriarInscricaoDto } from './inscricoes-competicao.dto';

export class CriarLoteInscricaoDto extends CriarInscricaoDto {
  @ApiPropertyOptional({ type: String, example: '10.00', description: 'Protecao contra mudanca de preco; nao define o valor cobrado.' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^\d{1,10}\.\d{2}$/)
  valorUnitarioEsperado?: string;
}

export class InscricaoLoteResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() timeIdCartola!: number;
  @ApiProperty({ enum: InscricaoTimeCompeticaoStatus }) statusInscricao!: InscricaoTimeCompeticaoStatus;
}

export class LoteInscricaoResponseDto {
  @ApiProperty() loteId!: number;
  @ApiProperty() competicaoId!: number;
  @ApiProperty() quantidade!: number;
  @ApiProperty({ enum: CompeticaoTipoAcesso }) tipoAcesso!: CompeticaoTipoAcesso;
  @ApiProperty({ example: 'BRL' }) moeda!: string;
  @ApiProperty({ example: '10.00' }) valorUnitario!: string;
  @ApiProperty({ example: '20.00' }) valorTotal!: string;
  @ApiProperty({ type: Number, nullable: true }) movimentacaoDebitoId!: number | null;
  @ApiProperty({ type: String, nullable: true, example: '5.00' }) saldoDisponivelAposOperacao!: string | null;
  @ApiProperty({ type: [InscricaoLoteResponseDto] }) inscricoes!: InscricaoLoteResponseDto[];
}
