import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { DesafioStatus } from '@prisma/client';
import { DesafiosPaginacaoDto } from './desafios-response.dto';

export class DesafioRankingQueryDto {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4294967295)
  pagina = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limite = 20;
}

export class DesafioRankingParticipanteDto {
  @ApiProperty() idUsuario!: number;
  @ApiProperty({ type: String, nullable: true }) nome!: string | null;
  @ApiProperty({ type: String, nullable: true }) fotoUrl!: string | null;
}

export class DesafioRankingItemDto {
  @ApiProperty({ description: 'Posicao compartilhada: 1, 1, 3, 4, 4' }) posicao!: number;
  @ApiProperty({ type: DesafioRankingParticipanteDto }) participante!: DesafioRankingParticipanteDto;
  @ApiProperty() pontos!: number;
  @ApiProperty() acertos!: number;
}

export class DesafioRankingDto {
  @ApiProperty() desafioId!: number;
  @ApiProperty({ enum: DesafioStatus }) status!: DesafioStatus;
  @ApiProperty() totalPartidasValidas!: number;
  @ApiProperty() totalPartidasApuradas!: number;
  @ApiProperty() totalPartidasAnuladas!: number;
  @ApiProperty({ description: 'Uma unidade por partida nao anulada, incluindo pendentes' }) pontuacaoMaxima!: number;
  @ApiProperty({ type: [DesafioRankingItemDto] }) ranking!: DesafioRankingItemDto[];
  @ApiProperty({ type: DesafiosPaginacaoDto }) paginacao!: DesafiosPaginacaoDto;
}
