import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserStatus, UserType, Usuario } from '@prisma/client';
import { FirebaseIdentity } from '../auth/firebase-identity.interface';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  private readonly rootEmail: string;
  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.rootEmail = config.getOrThrow<string>('ROOT_EMAIL').trim().toLowerCase();
  }

  async synchronizeVerifiedFirebase(identity: FirebaseIdentity): Promise<Usuario> {
    const email = identity.email.trim().toLowerCase();
    const isRoot = email === this.rootEmail;
    try {
      return await this.prisma.$transaction(async (tx) => {
        let user = await tx.usuario.findUnique({ where: { firebaseUid: identity.firebaseUid } });
        if (!user) {
          user = await tx.usuario.findUnique({ where: { email } });
          if (user?.firebaseUid && user.firebaseUid !== identity.firebaseUid) {
            throw new ConflictException('E-mail já vinculado a outra identidade Firebase');
          }
        }
        if (!user) {
          return tx.usuario.create({ data: { firebaseUid: identity.firebaseUid, nome: identity.nome, email, fotoUrl: identity.fotoUrl, tipoUsuario: isRoot ? UserType.PLATFORM_ADMIN : UserType.PLAYER, status: UserStatus.ATIVO } });
        }
        return tx.usuario.update({ where: { idUsuario: user.idUsuario }, data: { firebaseUid: identity.firebaseUid, nome: identity.nome ?? user.nome, email, fotoUrl: identity.fotoUrl ?? user.fotoUrl, ...(isRoot ? { tipoUsuario: UserType.PLATFORM_ADMIN } : {}) } });
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Identidade Firebase já vinculada');
      throw error;
    }
  }
}
