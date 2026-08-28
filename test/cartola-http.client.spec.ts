import { BadGatewayException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CartolaHttpClient } from '../src/cartola/cartola-http.client';

describe('CartolaHttpClient', () => {
  const config = { getOrThrow: () => 'https://cartola.test', get: () => 10 } as unknown as ConfigService;
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

  it('retorna JSON tipado em uma resposta válida', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rodada: 1 }) });
    await expect(new CartolaHttpClient(config).get('/partidas')).resolves.toEqual({ rodada: 1 });
  });

  it('traduz erro HTTP externo para 502', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(new CartolaHttpClient(config).get('/clubes')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('traduz timeout para 503', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as typeof fetch;
    const request = new CartolaHttpClient(config).get('/clubes');
    jest.advanceTimersByTime(11);
    await expect(request).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('preserva 404 externo como time não encontrado', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(new CartolaHttpClient(config).get('/time/id/999999', { notFoundMessage: 'Time não encontrado' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
