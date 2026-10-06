import { BadGatewayException, GatewayTimeoutException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiFootballClient } from './api-football.client';

describe('ApiFootballClient', () => {
  const key = 'segredo-apenas-de-teste';
  let client: ApiFootballClient;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    client = new ApiFootballClient(new ConfigService({ API_FOOTBALL_KEY: key }));
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  function response(status: number, body: unknown) {
    fetchMock.mockResolvedValue({ status, ok: status >= 200 && status < 300, json: jest.fn().mockResolvedValue(body) });
  }
  it('usa URL, header e envelope corretos sem expor chave', async () => {
    response(200, { errors: [], response: [] });
    await expect(client.events(42)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('https://v3.football.api-sports.io/fixtures/events?fixture=42',
      expect.objectContaining({ headers: { 'x-apisports-key': key, Accept: 'application/json' }, redirect: 'error' }));
  });
  it('chave ausente não faz requisição', async () => {
    client = new ApiFootballClient(new ConfigService({ API_FOOTBALL_KEY: '' }));
    await expect(client.events(1)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 500])('HTTP %i retorna erro sanitizado sem retry', async status => {
    response(status, { secret: key });
    await expect(client.events(1)).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('HTTP 429 retorna indisponibilidade controlada', async () => {
    response(429, {});
    await expect(client.events(1)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it.each([{ errors: { token: key }, response: [] }, { errors: [key], response: [] },
    { errors: [], response: {} }, null])('rejeita envelope inválido ou com errors: %p', async body => {
    response(200, body);
    await expect(client.events(1)).rejects.toThrow('Resposta inválida do serviço de partidas');
  });
  it('fixture vazio é 404', async () => {
    response(200, { errors: [], response: [] });
    await expect(client.fixture(1)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('fixture divergente ou incompleto é 502', async () => {
    response(200, { errors: [], response: [{ fixture: { id: 2 } }] });
    await expect(client.fixture(1)).rejects.toBeInstanceOf(BadGatewayException);
  });
  it('evento malformado é 502', async () => {
    response(200, { errors: [], response: [null] });
    await expect(client.events(1)).rejects.toBeInstanceOf(BadGatewayException);
  });
  it('erro de rede não vaza mensagem ou chave', async () => {
    fetchMock.mockRejectedValue(new Error(key));
    await expect(client.events(1)).rejects.toThrow('Não foi possível conectar ao serviço de partidas');
  });
  it('JSON inválido não vaza mensagem ou chave', async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: jest.fn().mockRejectedValue(new Error(key)) });
    await expect(client.events(1)).rejects.toThrow('Resposta inválida do serviço de partidas');
  });
  it('timeout aborta requisição sem retry', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error(key)));
    }));
    const result = expect(client.events(1)).rejects.toBeInstanceOf(GatewayTimeoutException);
    await jest.advanceTimersByTimeAsync(15000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
