import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { CartolaService } from '../cartola/cartola.service';
import { CachedResult, CartolaScoredAthletesPayload } from '../cartola/cartola.types';
import { ScoredAthletesCacheStore } from './scored-athletes-cache.store';

interface StoredScoredAthletes {
  cachedAt: string;
  payload: CartolaScoredAthletesPayload;
}

@Injectable()
export class ScoredAthletesCacheService {
  private readonly logger = new Logger(ScoredAthletesCacheService.name);
  private readonly staleTtlMs: number;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly pollMs = 50;

  constructor(
    private readonly store: ScoredAthletesCacheStore,
    private readonly cartola: CartolaService,
    config: ConfigService,
  ) {
    this.staleTtlMs = config.get<number>('REDIS_SCORED_STALE_TTL_SECONDS', 86400) * 1000;
    this.lockTtlMs = config.get<number>('REDIS_LOCK_TTL_MS', 10000);
    this.lockWaitMs = config.get<number>('REDIS_LOCK_WAIT_MS', 5000);
  }

  async getScoredAthletes(temporada: number, rodada: number): Promise<CachedResult<CartolaScoredAthletesPayload>> {
    this.validateIdentifiers(temporada, rodada);
    const key = this.cacheKey(temporada, rodada);
    const cached = await this.readValid(key, rodada);
    if (cached) {
      this.logger.debug({ event: 'scored_athletes_cache_hit', temporada, rodada, store: this.store.kind });
      return { value: cached.payload, cache: 'hit', stale: false };
    }

    this.logger.log({ event: 'scored_athletes_cache_miss', temporada, rodada, store: this.store.kind });
    return this.waitOrRefresh(temporada, rodada, key);
  }

  private async waitOrRefresh(temporada: number, rodada: number, key: string): Promise<CachedResult<CartolaScoredAthletesPayload>> {
    const lockKey = `${key}:lock`;
    const deadline = Date.now() + this.lockWaitMs;
    let waitingLogged = false;

    while (Date.now() <= deadline) {
      const cached = await this.readValid(key, rodada);
      if (cached) return { value: cached.payload, cache: 'hit', stale: false };

      const token = randomUUID();
      if (await this.store.setIfAbsent(lockKey, token, this.lockTtlMs)) {
        this.logger.log({ event: 'scored_athletes_lock_acquired', temporada, rodada, store: this.store.kind });
        try {
          return await this.refresh(temporada, rodada, key);
        } finally {
          await this.store.releaseLock(lockKey, token);
        }
      }

      if (!waitingLogged) {
        this.logger.log({ event: 'scored_athletes_lock_wait', temporada, rodada, store: this.store.kind });
        waitingLogged = true;
      }
      await this.delay(this.pollMs);
    }

    const stale = await this.readValid(`${key}:stale`, rodada);
    if (stale) {
      this.logger.warn({ event: 'scored_athletes_cache_stale', temporada, rodada, store: this.store.kind });
      return { value: stale.payload, cache: 'stale', stale: true };
    }
    throw new ServiceUnavailableException('Timeout aguardando atualização global dos atletas pontuados');
  }

  private async refresh(temporada: number, rodada: number, key: string): Promise<CachedResult<CartolaScoredAthletesPayload>> {
    const stale = await this.readValid(`${key}:stale`, rodada);
    try {
      const loaded = await this.cartola.loadScoredAthletesFresh();
      this.validateEnvelope(loaded.value, rodada);
      const serialized = JSON.stringify({ cachedAt: new Date().toISOString(), payload: loaded.value } satisfies StoredScoredAthletes);
      await Promise.all([
        this.store.set(key, serialized, loaded.ttlMs),
        this.store.set(`${key}:stale`, serialized, this.staleTtlMs),
      ]);
      this.logger.log({ event: 'scored_athletes_refresh_success', temporada, rodada, ttlMs: loaded.ttlMs, store: this.store.kind });
      return { value: loaded.value, cache: 'miss', stale: false };
    } catch (error) {
      this.logger.error({
        event: 'scored_athletes_refresh_error',
        temporada,
        rodada,
        store: this.store.kind,
        reason: error instanceof Error ? error.message : 'erro desconhecido',
      });
      if (stale) {
        this.logger.warn({ event: 'scored_athletes_cache_stale', temporada, rodada, store: this.store.kind });
        return { value: stale.payload, cache: 'stale', stale: true };
      }
      throw error;
    }
  }

  private async readValid(key: string, rodada: number): Promise<StoredScoredAthletes | null> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as StoredScoredAthletes;
      this.validateEnvelope(stored.payload, rodada);
      return stored;
    } catch {
      await this.store.delete(key);
      return null;
    }
  }

  private validateEnvelope(payload: CartolaScoredAthletesPayload, rodada: number): void {
    if (!this.isRecord(payload) || !this.isRecord(payload.atletas)) throw new BadGatewayException('Envelope de atletas pontuados inválido');
    if (!Number.isInteger(payload.rodada) || payload.rodada !== rodada) throw new BadGatewayException('Rodada inválida no envelope de atletas pontuados');
  }

  private validateIdentifiers(temporada: number, rodada: number): void {
    if (!Number.isInteger(temporada) || temporada < 1) throw new BadGatewayException('Temporada inválida para cache de pontuados');
    if (!Number.isInteger(rodada) || rodada < 1 || rodada > 38) throw new BadGatewayException('Rodada inválida para cache de pontuados');
  }

  private cacheKey(temporada: number, rodada: number): string {
    return `cartola:pontuados:${temporada}:${rodada}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
