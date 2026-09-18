import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LigaStatus, LigaTipo } from '@prisma/client';

export class AdminLigaDto {
  @ApiProperty() id!: number;
  @ApiProperty() nome!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: LigaTipo }) tipo!: LigaTipo;
  @ApiProperty({ enum: LigaStatus }) status!: LigaStatus;
  @ApiProperty() visivelApp!: boolean;
  @ApiPropertyOptional({ nullable: true }) imagemUrl!: string | null;
}

export class AdminLigaModalidadeDto {
  @ApiProperty() ligaModalidadeId!: number;
  @ApiProperty() modalidadeId!: number;
  @ApiProperty() codigo!: string;
  @ApiProperty() nome!: string;
  @ApiProperty() ativa!: boolean;
  @ApiProperty() ordem!: number;
}
