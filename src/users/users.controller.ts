import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUserResponseDto } from './dto/current-user-response.dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOkResponse({ type: CurrentUserResponseDto })
  @ApiUnauthorizedResponse({ description: 'JWT ausente, inválido ou expirado' })
  @ApiForbiddenResponse({ description: 'Usuário bloqueado' })
  getMe(@AuthenticatedUser() user: Usuario): CurrentUserResponseDto {
    return CurrentUserResponseDto.from(user);
  }
}
