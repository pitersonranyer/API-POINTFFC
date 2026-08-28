import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TimeUsuario } from '@prisma/client';

export class TimeUsuarioResponseDto {
  @ApiProperty({ example: 44566162 })
  timeId: number;

  @ApiProperty({ example: 'Meu Time FC' })
  nome: string;

  @ApiPropertyOptional({ nullable: true })
  nomeCartola: string | null;

  @ApiPropertyOptional({ nullable: true })
  slug: string | null;

  @ApiPropertyOptional({ nullable: true })
  urlEscudoPng: string | null;

  @ApiPropertyOptional({ nullable: true })
  fotoPerfil: string | null;

  @ApiPropertyOptional({ nullable: true })
  assinante: boolean | null;

  @ApiProperty()
  criadoEm: Date;

  @ApiProperty()
  atualizadoEm: Date;

  static from(model: TimeUsuario): TimeUsuarioResponseDto {
    const { timeId, nome, nomeCartola, slug, urlEscudoPng, fotoPerfil, assinante, criadoEm, atualizadoEm } = model;
    return { timeId, nome, nomeCartola, slug, urlEscudoPng, fotoPerfil, assinante, criadoEm, atualizadoEm };
  }
}
