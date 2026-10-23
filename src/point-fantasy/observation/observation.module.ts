import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ObservationService } from './observation.service';
import { CartolaObservationSource, ObservationSource } from './observation-source';

// Not imported by AppModule: explicit development execution only.
@Module({ imports: [PrismaModule], providers: [ObservationService,
  { provide: ObservationSource, useClass: CartolaObservationSource }], exports: [ObservationService] })
export class ObservationModule {}
