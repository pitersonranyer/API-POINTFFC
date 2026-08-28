import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }): unknown => typeof value === 'string' ? value.trim() : value;

export class AdicionarTimeDto {
  @ApiProperty({ example: 44566162, minimum: 1 })
  @IsInt({ message: 'timeId deve ser um numero inteiro' })
  @Min(1, { message: 'timeId deve ser maior que zero' })
  timeId: number;

  @ApiProperty({ example: 'Meu Time FC' })
  @Transform(trim)
  @IsString({ message: 'nome deve ser um texto' })
  @IsNotEmpty({ message: 'nome e obrigatorio' })
  @MaxLength(255)
  nome: string;

  @ApiPropertyOptional({ example: 'Joao Silva', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  nomeCartola?: string | null;

  @ApiPropertyOptional({ example: 'meu-time-fc', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  slug?: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/escudo.png', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsUrl({}, { message: 'urlEscudoPng deve ser uma URL valida' })
  urlEscudoPng?: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/perfil.png', nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsUrl({}, { message: 'fotoPerfil deve ser uma URL valida' })
  fotoPerfil?: string | null;

  @ApiPropertyOptional({ example: true, nullable: true })
  @IsOptional()
  @IsBoolean({ message: 'assinante deve ser booleano' })
  assinante?: boolean | null;
}
