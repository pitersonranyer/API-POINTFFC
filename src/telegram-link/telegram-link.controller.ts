import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiOkResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConfirmTelegramLinkDto } from './dto/confirm-telegram-link.dto';
import { TelegramLinkService } from './telegram-link.service';

@ApiTags('Telegram account link')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('users/me/telegram-link')
export class TelegramLinkController {
  constructor(private readonly links: TelegramLinkService) {}

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Vínculo confirmado; retorna apenas estado e data de criação.' })
  @ApiBadRequestResponse({ description: 'Código inválido, expirado ou já utilizado.' })
  @ApiConflictResponse({ description: 'Usuário POINT FFC ou identidade Telegram já possui vínculo.' })
  @ApiTooManyRequestsResponse({ description: 'Limite de confirmações atingido.' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente, inválido ou expirado.' })
  @ApiForbiddenResponse({ description: 'Usuário bloqueado.' })
  confirm(@AuthenticatedUser() user: Usuario, @Body() dto: ConfirmTelegramLinkDto) {
    return this.links.confirm(user.idUsuario, dto.code);
  }

  @Get()
  @ApiOkResponse({ description: 'Estado do vínculo da conta autenticada.' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente, inválido ou expirado.' })
  @ApiForbiddenResponse({ description: 'Usuário bloqueado.' })
  status(@AuthenticatedUser() user: Usuario) {
    return this.links.status(user.idUsuario);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Vínculo removido, sem revelar a identidade Telegram.' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente, inválido ou expirado.' })
  @ApiForbiddenResponse({ description: 'Usuário bloqueado.' })
  disconnect(@AuthenticatedUser() user: Usuario) {
    return this.links.disconnect(user.idUsuario);
  }
}
