import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { UserStatus, UserType } from '@prisma/client';
import { AuthenticatedRequest } from './jwt-auth.guard';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (user?.tipoUsuario !== UserType.PLATFORM_ADMIN || user.status !== UserStatus.ATIVO) {
      throw new ForbiddenException('Acesso exclusivo para ADMIN ativo');
    }
    return true;
  }
}
