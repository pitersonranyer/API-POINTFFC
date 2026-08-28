import { Module } from '@nestjs/common';
import { CartolaCacheService } from './cartola-cache.service';
import { CartolaController } from './cartola.controller';
import { CartolaHttpClient } from './cartola-http.client';
import { CartolaService } from './cartola.service';

@Module({ controllers: [CartolaController], providers: [CartolaHttpClient, CartolaCacheService, CartolaService], exports: [CartolaService] })
export class CartolaModule {}
