import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { environmentValidationSchema } from './config/environment.validation';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { CartolaModule } from './cartola/cartola.module';
import { MeusTimesModule } from './meus-times/meus-times.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: environmentValidationSchema }),
    PrismaModule,
    UsersModule,
    AuthModule,
    HealthModule,
    CartolaModule,
    MeusTimesModule,
  ],
})
export class AppModule {}
