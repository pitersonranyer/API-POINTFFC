import { Module } from '@nestjs/common';
import { CartolaCacheService } from './cartola-cache.service';
import { CartolaController } from './cartola.controller';
import { CartolaHttpClient } from './cartola-http.client';
import { CartolaService } from './cartola.service';
import { AthleteHistoryController } from './athlete-history.controller';
import { AthleteHistoryService } from './athlete-history.service';

@Module({ controllers: [CartolaController, AthleteHistoryController], providers: [CartolaHttpClient, CartolaCacheService, CartolaService, AthleteHistoryService], exports: [CartolaService] })
export class CartolaModule {}
