import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { FirebaseIdentity } from './firebase-identity.interface';

@Injectable()
export class FirebaseService {
  private readonly auth: Auth;

  constructor(config: ConfigService) {
    const app: App = getApps()[0] ?? initializeApp({
      credential: cert({
        projectId: config.getOrThrow<string>('FIREBASE_PROJECT_ID'),
        clientEmail: config.getOrThrow<string>('FIREBASE_CLIENT_EMAIL'),
        privateKey: config.getOrThrow<string>('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      }),
    });
    this.auth = getAuth(app);
  }

  async verifyIdToken(idToken: string): Promise<FirebaseIdentity> {
    try {
      const token = await this.auth.verifyIdToken(idToken, true);
      if (!token.email) throw new UnauthorizedException('Conta Firebase sem e-mail');

      return {
        firebaseUid: token.uid,
        nome: typeof token.name === 'string' ? token.name : null,
        email: token.email.trim().toLowerCase(),
        fotoUrl: typeof token.picture === 'string' ? token.picture : null,
        emailVerified: token.email_verified === true,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Firebase ID Token inválido ou expirado');
    }
  }
}
