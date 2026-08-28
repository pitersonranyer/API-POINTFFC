import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { FirebaseSessionDto } from './dto/firebase-session.dto';

@ApiTags('auth') @Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('firebase/session') @HttpCode(HttpStatus.OK) @ApiOkResponse({ description: 'JWT Fantasy Point e usuário interno' }) @ApiUnauthorizedResponse({ description: 'Firebase ID Token inválido ou expirado' }) @ApiForbiddenResponse({ description: 'E-mail não confirmado ou usuário bloqueado' })
  session(@Body() dto: FirebaseSessionDto) { return this.auth.createFirebaseSession(dto.idToken); }
}
