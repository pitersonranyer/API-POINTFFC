import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { UserStatus, Usuario } from '@prisma/client';
import { Request } from 'express';
import { AuthService } from './auth.service';
export interface AuthenticatedRequest extends Request { user: Usuario }
@Injectable() export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) { const req=context.switchToHttp().getRequest<AuthenticatedRequest>(); const match=req.headers.authorization?.match(/^Bearer\s+(.+)$/i); if(!match) throw new UnauthorizedException('Token de acesso ausente ou inválido'); const user=await this.auth.authenticateJwt(match[1]); if(user.status===UserStatus.BLOQUEADO) throw new ForbiddenException('Usuário bloqueado'); req.user=user; return true; }
}
