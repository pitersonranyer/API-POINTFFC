import { BadRequestException, Body, Controller, Get, Header, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { IsIn, IsString } from 'class-validator';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CREST_CATALOG, CREST_CATALOG_VERSION, CREST_IDS, participantCrest } from './participant-crest';

export class UpdateParticipantCrestDto {
  @IsString() @IsIn(CREST_IDS) brasaoId: string;
}

@ApiTags('point-fantasy')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('point-fantasy')
export class ParticipantCrestController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('brasoes')
  catalog() { return { versao: CREST_CATALOG_VERSION, items: CREST_CATALOG }; }

  @Get('participante/brasao')
  @Header('Cache-Control', 'private, no-store')
  async get(@AuthenticatedUser() user: Usuario) {
    const saved = await this.prisma.usuario.findUniqueOrThrow({ where: { idUsuario: user.idUsuario },
      select: { fantasyBrasaoId: true } });
    return { brasaoId: participantCrest(user.idUsuario, saved.fantasyBrasaoId), escolhido: saved.fantasyBrasaoId !== null };
  }

  @Patch('participante/brasao')
  @Header('Cache-Control', 'private, no-store')
  async update(@AuthenticatedUser() user: Usuario, @Body() dto: UpdateParticipantCrestDto) {
    if (!CREST_IDS.includes(dto.brasaoId)) throw new BadRequestException('Brasao Fantasy invalido');
    await this.prisma.usuario.update({ where: { idUsuario: user.idUsuario }, data: { fantasyBrasaoId: dto.brasaoId },
      select: { idUsuario: true } });
    return { brasaoId: dto.brasaoId, escolhido: true };
  }
}
