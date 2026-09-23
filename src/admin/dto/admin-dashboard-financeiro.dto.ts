import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CompeticaoLigaStatus, CompeticaoTipoAcesso, CompeticaoTipoTaxaPlataforma, PremiacaoCompeticaoTipo } from '@prisma/client';

export class DashboardFinanceiroQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  ligaId?: number;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  competicaoId?: number;

  @ApiPropertyOptional({ description: 'Seleciona competicoes cujo intervalo contem a rodada; nao rateia os valores.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(255)
  rodada?: number;

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  pagina = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limite = 20;
}

export class DashboardFinanceiroValoresDto {
  @ApiProperty({ example: '1000.00' }) valorInscricoes!: string;
  @ApiProperty({ example: '100.00' }) receitaPointPrevista!: string;
  @ApiProperty({ example: '900.00' }) basePremiacao!: string;
  @ApiProperty({ example: '600.00' }) premiacaoCalculada!: string;
  @ApiProperty({ example: '300.00' }) saldoAposPremiacao!: string;
}

class DashboardTotalizadoresDto extends DashboardFinanceiroValoresDto {
  @ApiProperty() quantidadeCompeticoes!: number;
  @ApiProperty() totalInscritos!: number;
  @ApiProperty() inscricoesCanceladas!: number;
}

class DashboardLigaDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
}

class DashboardModalidadeDto extends DashboardLigaDto {
  @ApiProperty() codigo!: string;
}

class DashboardInscritosDto {
  @ApiProperty() ativos!: number;
  @ApiProperty() finalizados!: number;
  @ApiProperty() cancelados!: number;
  @ApiProperty() totalConsiderado!: number;
}

class DashboardTaxaDto {
  @ApiProperty({ enum: CompeticaoTipoTaxaPlataforma, nullable: true }) tipo!: CompeticaoTipoTaxaPlataforma | null;
  @ApiProperty({ type: String, nullable: true }) valor!: string | null;
}

class DashboardPremiacaoDto {
  @ApiProperty() posicaoInicio!: number;
  @ApiProperty() posicaoFim!: number;
  @ApiProperty({ enum: PremiacaoCompeticaoTipo }) tipoPremiacao!: PremiacaoCompeticaoTipo;
  @ApiProperty({ type: String, nullable: true }) valor!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '25.0000' }) percentual!: string | null;
  @ApiProperty() ordem!: number;
  @ApiProperty() valorCalculado!: string;
}

export class DashboardFinanceiroItemDto {
  @ApiProperty() competicaoId!: number;
  @ApiProperty() nome!: string;
  @ApiProperty({ type: DashboardLigaDto }) liga!: DashboardLigaDto;
  @ApiProperty({ type: DashboardModalidadeDto }) modalidade!: DashboardModalidadeDto;
  @ApiProperty({ type: Number, nullable: true }) rodadaInicio!: number | null;
  @ApiProperty({ type: Number, nullable: true }) rodadaFim!: number | null;
  @ApiProperty({ enum: CompeticaoLigaStatus }) status!: CompeticaoLigaStatus;
  @ApiProperty({ enum: CompeticaoTipoAcesso }) tipoAcesso!: CompeticaoTipoAcesso;
  @ApiProperty() valorInscricao!: string;
  @ApiProperty({ type: DashboardInscritosDto }) inscritos!: DashboardInscritosDto;
  @ApiProperty({ type: DashboardTaxaDto }) taxaPlataforma!: DashboardTaxaDto;
  @ApiProperty({ type: DashboardFinanceiroValoresDto }) financeiro!: DashboardFinanceiroValoresDto;
  @ApiProperty({ type: [DashboardPremiacaoDto] }) premiacoes!: DashboardPremiacaoDto[];
}

class DashboardPaginacaoDto {
  @ApiProperty() pagina!: number;
  @ApiProperty() limite!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPaginas!: number;
}

export class DashboardFinanceiroResponseDto {
  @ApiProperty({ enum: ['PREVISTO_NOMINAL'] }) natureza!: 'PREVISTO_NOMINAL';
  @ApiProperty({ type: DashboardTotalizadoresDto }) totalizadores!: DashboardTotalizadoresDto;
  @ApiProperty({ type: [DashboardFinanceiroItemDto] }) itens!: DashboardFinanceiroItemDto[];
  @ApiProperty({ type: DashboardPaginacaoDto }) paginacao!: DashboardPaginacaoDto;
}
