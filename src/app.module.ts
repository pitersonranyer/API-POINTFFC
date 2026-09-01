import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { environmentValidationSchema } from './config/environment.validation';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { CartolaModule } from './cartola/cartola.module';
import { MeusTimesModule } from './meus-times/meus-times.module';
import { TimeSnapshotsModule } from './time-snapshots/time-snapshots.module';
import { PartialScoreModule } from './partial-score/partial-score.module';
import { ScoredAthletesCacheModule } from './scored-athletes-cache/scored-athletes-cache.module';
import { ParciaisModule } from './parciais/parciais.module';
import { SubstitutionModule } from './substitutions/substitution.module';
import { RankingGeralModule } from './ranking-geral/ranking-geral.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: environmentValidationSchema }),
    PrismaModule,
    UsersModule,
    AuthModule,
    HealthModule,
    CartolaModule,
    MeusTimesModule,
    TimeSnapshotsModule,
    PartialScoreModule,
    ScoredAthletesCacheModule,
    ParciaisModule,
    SubstitutionModule,
    RankingGeralModule,
  ],
})
export class AppModule {}
