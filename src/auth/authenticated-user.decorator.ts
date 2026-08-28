import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Usuario } from '@prisma/client';
import { AuthenticatedRequest } from './jwt-auth.guard';

export const AuthenticatedUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Usuario =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
