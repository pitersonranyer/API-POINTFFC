import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';
import { InscricaoTimeCompeticaoStatus } from '@prisma/client';

export class CriarInscricaoDto {
  @ApiProperty({ type: [Number], minItems: 1, maxItems: 50, uniqueItems: true, example: [44566162, 13933388] })
  @IsArray({ message: 'timesCartolaIds deve ser uma lista' })
  @ArrayMinSize(1, { message: 'informe ao menos um time' })
  @ArrayMaxSize(50, { message: 'o limite e de 50 times por solicitacao' })
  @ArrayUnique({ message: 'timesCartolaIds nao pode conter IDs duplicados' })
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(4294967295, { each: true })
  timesCartolaIds!: number[];
}

export class MinhaInscricaoDto {
  @ApiProperty() id!: number;
  @ApiProperty() timeIdCartola!: number;
  @ApiProperty() nomeTime!: string;
  @ApiProperty({ type: String, nullable: true }) nomeCartoleiro!: string | null;
  @ApiProperty({ type: String, nullable: true }) escudoUrl!: string | null;
  @ApiProperty({ enum: InscricaoTimeCompeticaoStatus }) statusInscricao!: InscricaoTimeCompeticaoStatus;
  @ApiProperty({ type: Number, nullable: true }) pontuacao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicaoAnterior!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premioApurado!: number | null;
  @ApiProperty({ format: 'date-time' }) dataInscricao!: string;
  @ApiProperty({ type: Number }) valorInscricao!: number;
}

export class CriarInscricoesResponseDto {
  @ApiProperty({ type: [MinhaInscricaoDto] }) inscricoes!: MinhaInscricaoDto[];
  @ApiProperty({ minimum: 1 }) quantidade!: number;
}

export class ParticipanteCompeticaoDto {
  @ApiProperty() id!: number;
  @ApiProperty() nomeTime!: string;
  @ApiProperty({ type: String, nullable: true }) nomeCartoleiro!: string | null;
  @ApiProperty({ type: String, nullable: true }) escudoUrl!: string | null;
  @ApiProperty({ type: Number, nullable: true }) pontuacao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicaoAnterior!: number | null;
}
