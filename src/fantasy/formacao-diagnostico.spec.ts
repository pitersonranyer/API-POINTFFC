import { BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiFootballClient } from './api-football.client';
import { FantasyService } from './fantasy.service';
import { marcarDiagnostico } from './formacao-diagnostico';

const fixture = {
  fixture: { id: 1180729, date: '2024-12-08T19:00:00+00:00', status: { short: 'FT' }, venue: { name: null } },
  league: { name: 'Serie A', round: 'Regular Season - 38' },
  teams: { home: { id: 120, name: 'Botafogo', logo: null }, away: { id: 126, name: 'Sao Paulo', logo: null } },
  goals: { home: 2, away: 1 },
};
const player = { player: { id: 1, name: 'Nome privado', number: 12, pos: 'G', grid: '1:1' } };
const lineup = { team: { id: 120 }, startXI: [player], substitutes: [] };
const publicError = { message: 'Resposta inválida do serviço de partidas', error: 'Bad Gateway', statusCode: 502 };

describe('Instrumentação temporária de Formação', () => {
  let warn: jest.SpyInstance;
  let fetchMock: jest.SpyInstance;
  let service: FantasyService;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock = jest.spyOn(global, 'fetch');
    service = new FantasyService(new ApiFootballClient(new ConfigService({ API_FOOTBALL_KEY: 'segredo-de-teste' })));
  });
  afterEach(() => jest.restoreAllMocks());
  function response(body: unknown) { return { status: 200, ok: true, json: async () => body }; }

  it.each([
    { etapa: 'fixture', categoria: 'FIXTURE_INVALIDO', body: { errors: [], response: [{ fixture: { id: 2 } }] } },
    { etapa: 'lineups', categoria: 'JSON_INVALIDO', jsonInvalid: true },
    { etapa: 'lineups', categoria: 'ENVELOPE_INVALIDO', body: { errors: [], response: {} } },
    { etapa: 'lineups', categoria: 'PROVIDER_ERRORS', body: { errors: { token: 'segredo-do-provider' }, response: [] } },
    { etapa: 'mapper', categoria: 'EQUIPE_INVALIDA', body: { errors: [], response: [{ team: { id: 999 } }] } },
    { etapa: 'mapper', categoria: 'JOGADOR_INVALIDO', body: { errors: [], response: [{ ...lineup, startXI: [{ player: { id: null } }] }] } },
    { etapa: 'mapper', categoria: 'ATRIBUTO_INVALIDO', body: { errors: [], response: [{ ...lineup, formation: 433 }] } },
    { etapa: 'mapper', categoria: 'ID_DUPLICADO', body: { errors: [], response: [{ ...lineup, substitutes: [player] }] } },
  ])('classifica $etapa/$categoria sem mudar o 502 ou registrar dados externos', async sample => {
    if (sample.etapa !== 'fixture') fetchMock.mockResolvedValueOnce(response({ errors: [], response: [fixture] }));
    fetchMock.mockResolvedValueOnce('jsonInvalid' in sample ? {
      status: 200, ok: true, json: async () => { throw new Error('segredo-interno'); },
    } : response(sample.body));
    const error = await service.formacao('1180729').catch(error => error);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toEqual(publicError);
    // O único argumento é o marcador e os dois valores controlados; sem erro/stack/payload.
    const expected = [[`[FANTASY_FORMACAO] etapa=${sample.etapa} categoria=${sample.categoria}`]];
    if (sample.categoria === 'PROVIDER_ERRORS') expected.unshift(['[FANTASY_API_FOOTBALL] provider_error_keys=["token"]']);
    expect(warn.mock.calls).toEqual(expected);
  });

  it('relança a mesma exceção de lineups e não adiciona metadados serializáveis', async () => {
    const error = marcarDiagnostico(new BadGatewayException(publicError.message), 'PROVIDER_ERRORS');
    const before = JSON.stringify(error);
    service = new FantasyService({ fixture: async () => fixture, lineups: async () => { throw error; } } as unknown as ApiFootballClient);
    await expect(service.formacao('1180729')).rejects.toBe(error);
    expect(JSON.stringify(error)).toBe(before);
    expect(error.getResponse()).toEqual(publicError);
  });

  it('erro não classificado é registrado sem mensagem ou stack e relançado intacto', async () => {
    const error = new Error('mensagem-com-segredo');
    fetchMock.mockImplementationOnce(() => { throw error; });
    service = new FantasyService({ fixture: async () => { throw error; } } as unknown as ApiFootballClient);
    await expect(service.formacao('1180729')).rejects.toBe(error);
    expect(warn.mock.calls).toEqual([['[FANTASY_FORMACAO] etapa=fixture categoria=ERRO_DESCONHECIDO']]);
  });

  it('resposta válida/vazia permanece igual e não gera log diagnóstico', async () => {
    fetchMock.mockResolvedValueOnce(response({ errors: [], response: [fixture] }))
      .mockResolvedValueOnce(response({ errors: [], response: [] }));
    await expect(service.formacao('1180729')).resolves.toEqual({
      partida: { idExterno: 1180729 },
      mandante: { idExterno: 120, nome: 'Botafogo', logo: null, formacao: null, treinador: null, titulares: [], reservas: [] },
      visitante: { idExterno: 126, nome: 'Sao Paulo', logo: null, formacao: null, treinador: null, titulares: [], reservas: [] },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['sumario', 'estatisticas'] as const)('%s continua sem logs de Formação em falhas', async method => {
    fetchMock.mockResolvedValueOnce(response({ errors: { token: 'segredo' }, response: [] }));
    await expect(service[method]('1180729')).rejects.toBeInstanceOf(BadGatewayException);
    expect(warn.mock.calls).toEqual([['[FANTASY_API_FOOTBALL] provider_error_keys=["token"]']]);
  });
});
