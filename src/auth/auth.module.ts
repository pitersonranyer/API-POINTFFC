import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({ imports: [forwardRef(() => UsersModule), JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.getOrThrow('JWT_SECRET'), signOptions: { expiresIn: config.getOrThrow('JWT_EXPIRES_IN') } }) })], controllers: [AuthController], providers: [AuthService, FirebaseService, JwtAuthGuard], exports: [AuthService, JwtAuthGuard] })
export class AuthModule {}
