import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PremiacaoCompeticaoTipo } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsNumber, IsOptional, Min, ValidateNested } from 'class-validator';

export class AdminPremiacaoInputDto {
  @ApiProperty({ minimum: 1, description: 'Primeira posicao premiada.' })
  @IsInt()
  @Min(1)
  posicaoInicio!: number;

  @ApiProperty({ minimum: 1, description: 'VALOR_FIXO permite faixa; PERCENTUAL exige o mesmo valor de posicaoInicio.' })
  @IsInt()
  @Min(1)
  posicaoFim!: number;

  @ApiProperty({ enum: PremiacaoCompeticaoTipo })
  @IsEnum(PremiacaoCompeticaoTipo)
  tipoPremiacao!: PremiacaoCompeticaoTipo;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Premio fixo por posicao.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  valor?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Percentual por posicao sobre valor das inscricoes menos taxa POINT. Soma da grade ate 100%.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  percentual?: number | null;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  ordem?: number;
}

export class SubstituirAdminPremiacoesDto {
  @ApiProperty({ type: [AdminPremiacaoInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminPremiacaoInputDto)
  premiacoes!: AdminPremiacaoInputDto[];
}

export class AdminPremiacaoResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() competicaoLigaId!: number;
  @ApiProperty() posicaoInicio!: number;
  @ApiProperty() posicaoFim!: number;
  @ApiProperty({ enum: PremiacaoCompeticaoTipo }) tipoPremiacao!: PremiacaoCompeticaoTipo;
  @ApiProperty({ type: Number, nullable: true }) valor!: number | null;
  @ApiProperty({ type: Number, nullable: true }) percentual!: number | null;
  @ApiProperty() ordem!: number;
  @ApiProperty({ type: String, format: 'date-time' }) criadoEm!: string;
  @ApiProperty({ type: String, format: 'date-time' }) atualizadoEm!: string;
}
