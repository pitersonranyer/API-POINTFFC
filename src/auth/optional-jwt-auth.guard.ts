import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authorization = context.switchToHttp().getRequest().headers.authorization;
    if (authorization === undefined) return true;
    return super.canActivate(context);
  }
}
