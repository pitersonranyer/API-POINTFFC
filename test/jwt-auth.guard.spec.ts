import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';

describe('JwtAuthGuard', () => {
  const request:any={headers:{}}; const context={switchToHttp:()=>({getRequest:()=>request})} as ExecutionContext;
  const auth={authenticateJwt:jest.fn()}; const guard=new JwtAuthGuard(auth as never);
  beforeEach(()=>{jest.clearAllMocks();request.headers={};delete request.user});
  it('rejeita token ausente',async()=>{await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)});
  it('rejeita token inválido/expirado',async()=>{request.headers.authorization='Bearer bad';auth.authenticateJwt.mockRejectedValue(new UnauthorizedException());await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)});
  it('rejeita usuário bloqueado',async()=>{request.headers.authorization='Bearer ok';auth.authenticateJwt.mockResolvedValue({status:UserStatus.BLOQUEADO});await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException)});
  it('anexa usuário para JWT válido',async()=>{request.headers.authorization='Bearer ok';const user={status:UserStatus.ATIVO};auth.authenticateJwt.mockResolvedValue(user);await expect(guard.canActivate(context)).resolves.toBe(true);expect(request.user).toBe(user)});
});
