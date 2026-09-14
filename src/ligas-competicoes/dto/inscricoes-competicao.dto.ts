import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { InscricaoTimeCompeticaoStatus } from '@prisma/client';

export class CriarInscricaoDto {
  @ApiProperty({ minimum: 1, example: 44566162 })
  @IsInt() @Min(1) @Max(4294967295)
  timeIdCartola!: number;
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

export class ParticipanteCompeticaoDto {
  @ApiProperty() id!: number;
  @ApiProperty() nomeTime!: string;
  @ApiProperty({ type: String, nullable: true }) nomeCartoleiro!: string | null;
  @ApiProperty({ type: String, nullable: true }) escudoUrl!: string | null;
  @ApiProperty({ type: Number, nullable: true }) pontuacao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicao!: number | null;
  @ApiProperty({ type: Number, nullable: true }) posicaoAnterior!: number | null;
}
