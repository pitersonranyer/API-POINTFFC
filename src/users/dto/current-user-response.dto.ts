import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus, UserType, Usuario } from '@prisma/client';

export class CurrentUserResponseDto {
  @ApiProperty({ example: 1 }) idUsuario: number;
  @ApiPropertyOptional({ nullable: true }) nome: string | null;
  @ApiProperty({ format: 'email' }) email: string;
  @ApiPropertyOptional({ nullable: true }) fotoUrl: string | null;
  @ApiProperty({ enum: UserType }) tipoUsuario: UserType;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;

  static from(user: Usuario): CurrentUserResponseDto {
    return {
      idUsuario: user.idUsuario,
      nome: user.nome,
      email: user.email,
      fotoUrl: user.fotoUrl,
      tipoUsuario: user.tipoUsuario,
      status: user.status,
    };
  }
}
