import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Usuario } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUserResponseDto } from '../users/dto/current-user-response.dto';
import { UsersService } from '../users/users.service';
import { FirebaseService } from './firebase.service';

export interface AuthResponse { accessToken: string; tokenType: 'Bearer'; expiresIn: string; user: CurrentUserResponseDto }

@Injectable()
export class AuthService {
  constructor(private readonly firebase: FirebaseService, private readonly users: UsersService, private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly config: ConfigService) {}
  async createFirebaseSession(idToken: string): Promise<AuthResponse> {
    const identity = await this.firebase.verifyIdToken(idToken);
    if (!identity.emailVerified) throw new ForbiddenException('Confirme seu e-mail antes de continuar');
    const user = await this.users.synchronizeVerifiedFirebase(identity);
    if (user.status === 'BLOQUEADO') throw new ForbiddenException('Usuário bloqueado');
    return this.session(user);
  }
  private session(user: Usuario): AuthResponse { return { accessToken: this.jwt.sign({ sub: user.idUsuario }), tokenType: 'Bearer', expiresIn: this.config.getOrThrow('JWT_EXPIRES_IN'), user: CurrentUserResponseDto.from(user) }; }
  async authenticateJwt(token: string): Promise<Usuario> { try { const payload=await this.jwt.verifyAsync<{sub:number}>(token); const user=await this.prisma.usuario.findUnique({where:{idUsuario:payload.sub}}); if(!user)throw new Error(); return user; } catch { throw new UnauthorizedException('Token de acesso inválido ou expirado'); } }
}
