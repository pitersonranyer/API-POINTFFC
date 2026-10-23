import { Injectable } from '@nestjs/common';
import { ObservationError } from './official-normalizer';

export interface SourceResponse {
  endpoint: string;
  receivedAt: string;
  status: number | null;
  text: string | null;
  headers: Record<string, string>;
  error: string | null;
}
export abstract class ObservationSource {
  abstract get(endpoint: string): Promise<SourceResponse>;
}

/** Deliberately bypasses CartolaService caches and all traditional persistence. */
@Injectable()
export class CartolaObservationSource extends ObservationSource {
  async get(endpoint: string): Promise<SourceResponse> {
    if (!/^\/(mercado\/status|atletas\/pontuados(?:\/\d+)?|partidas\/\d+)$/.test(endpoint)) {
      throw new ObservationError('ENDPOINT_NOT_ALLOWED');
    }
    const result: SourceResponse = { endpoint, receivedAt: '', status: null, text: null, headers: {}, error: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let stage: 'NETWORK' | 'BODY_READ' | 'UTF8' = 'NETWORK';
    try {
      // The legacy cartolafc host redirects to this official canonical host.
      const response = await fetch('https://api.cartola.globo.com' + endpoint, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'FantasyPointObservation/1.0' },
      });
      result.status = response.status;
      stage = 'BODY_READ';
      for (const key of ['date', 'age', 'cache-control', 'etag', 'last-modified']) {
        const value = response.headers.get(key); if (value !== null) result.headers[key] = value.slice(0, 1000);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      if (reader) for (;;) {
        const item = await reader.read(); if (item.done) break;
        length += item.value.byteLength;
        if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new ObservationError('PAYLOAD_TOO_LARGE'); }
        chunks.push(item.value);
      }
      stage = 'UTF8';
      result.text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      if (!response.ok) result.error = 'HTTP_' + response.status;
    } catch (error) {
      result.error = error instanceof ObservationError ? error.code : controller.signal.aborted ? 'PROVIDER_TIMEOUT'
        : stage === 'UTF8' ? 'PROVIDER_INVALID_UTF8' : stage === 'BODY_READ' ? 'PROVIDER_BODY_READ_FAILED' : 'PROVIDER_NETWORK';
    } finally { clearTimeout(timer); result.receivedAt = new Date().toISOString(); }
    return result;
  }
}
