import { BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiFootballClient } from './api-football.client';

describe('Diagnóstico seguro de errors do provider', () => {
  let warn: jest.SpyInstance;
  let fetchMock: jest.SpyInstance;
  let client: ApiFootballClient;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock = jest.spyOn(global, 'fetch');
    client = new ApiFootballClient(new ConfigService({ API_FOOTBALL_KEY: 'SEGREDO_API' }));
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([
    { errors: { requests: 'SEGREDO_API limite' }, keys: ['requests'] },
    { errors: { token: 'SEGREDO_API' }, keys: ['token'] },
    { errors: { subscription: { segredo: 'SEGREDO_API' }, season: 'mensagem externa' }, keys: ['season', 'subscription'] },
    { errors: { 'SEGREDO_API\nAuthorization': 'SEGREDO_API', desconhecida: 'texto' }, keys: ['OUTRO'] },
    { errors: ['SEGREDO_API'], keys: ['FORMATO_ARRAY'] },
  ])('registra somente rótulos controlados e mantém o mesmo 502', async ({ errors, keys }) => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ errors,
      response: [{ fixture: 'NAO_REGISTRAR', equipe: 'NAO_REGISTRAR' }], headers: { Authorization: 'SEGREDO_API' } }) });
    const error = await client.fixture(1180729).catch(error => error);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toEqual({ message: 'Resposta inválida do serviço de partidas', error: 'Bad Gateway', statusCode: 502 });
    expect(warn.mock.calls).toEqual([[`[FANTASY_API_FOOTBALL] provider_error_keys=${JSON.stringify(keys)}`]]);
  });
  it('limita a quantidade e tamanho dos rótulos registrados', async () => {
    const errors = Object.fromEntries(['requests', 'rateLimit', 'token', 'subscription', 'season', 'request',
      'authentication', 'authorization', 'access', 'plan', 'parameters', 'fixture', 'x'.repeat(10000)]
      .map(key => [key, 'SEGREDO_API']));
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ errors, response: [] }) });
    await expect(client.lineups(1)).rejects.toBeInstanceOf(BadGatewayException);
    const log = warn.mock.calls[0][0];
    const keys = JSON.parse(log.split('provider_error_keys=')[1]);
    expect(keys).toHaveLength(8);
    expect(log.length).toBeLessThan(250);
    expect(log).not.toContain('SEGREDO_API');
  });
  it.each([[], {}])('resposta válida com errors vazio %p não gera log', async errors => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ errors, response: [] }) });
    await expect(client.lineups(1)).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
  it('envelope inválido sem provider errors não gera o novo log', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ errors: null, response: [] }) });
    await expect(client.lineups(1)).rejects.toBeInstanceOf(BadGatewayException);
    expect(warn).not.toHaveBeenCalled();
  });
});
