import { ConfigService } from '@nestjs/config';
import { FootballDataClient } from '../src/futebol/football-data.client';
import { mapDesafioMatch, parseDesafioMatches } from '../src/futebol/football-data.normalizer';
import { FUTEBOL_COMPETICOES } from '../src/futebol/futebol-competicoes';

const match = { id: 123, competition: { id: 2013, name: 'Serie A' }, utcDate: '2030-10-03T16:00:00Z',
  status: 'TIMED', homeTeam: { id: 1, name: 'A', crest: 'https://example.com/a.png' }, awayTeam: { id: 2, name: 'B' } };

describe('football-data para Desafios', () => {
  afterEach(() => jest.restoreAllMocks());

  it('agrega competicoes suportadas em uma chamada, deduplica e compartilha consultas/cache', async () => {
    const rows = FUTEBOL_COMPETICOES.map((code, index) => ({ ...match, id: 123 + index,
      competition: { id: 2000 + index, name: code, code } }));
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ matches: [
      ...rows, rows[0], { ...match, id: 500, competition: { id: 500, name: 'Outra', code: 'OTHER' } },
      { ...rows[0], id: 600, utcDate: '2030-10-08T00:00:00Z' },
    ] }), { status: 200 }));
    const client = new FootballDataClient({ get: () => 'test-token' } as unknown as ConfigService);
    const [a, b] = await Promise.all([client.pesquisarPartidasPorPeriodo('2030-10-01', '2030-10-07'),
      client.pesquisarPartidasPorPeriodo('2030-10-01', '2030-10-07')]);
    expect(a).toHaveLength(10);
    expect(new Set(a.map(p => p.fixtureId)).size).toBe(10);
    expect(a.map(p => p.leagueNome)).toEqual([...FUTEBOL_COMPETICOES]);
    expect(b).toEqual(a);
    a[0].mandanteNome = 'Alterado';
    expect((await client.pesquisarPartidasPorPeriodo('2030-10-01', '2030-10-07'))[0].mandanteNome).toBe('A');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/v4/matches');
    expect(Object.fromEntries(url.searchParams)).toEqual({ dateFrom: '2030-10-01', dateTo: '2030-10-08',
      competitions: '2013,2001,2021,2014,2019,2002,2015,2017,2003,2016' });
  });

  it.each([['2030-02-30', '2030-03-01'], ['2030-10-01', '2030-10-08'], ['2030-10-03', '2030-10-01'],
    ['', '2030-10-03'], ['2030-10-03', ''], ['ontem', '2030-10-03']])('rejeita periodo invalido %s/%s sem consumir provider', async (inicio, fim) => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const client = new FootballDataClient({ get: () => 'test-token' } as unknown as ConfigService);
    await expect(client.pesquisarPartidasPorPeriodo(inicio, fim)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cache expira e revalidacao por ID sempre consulta o provider', async () => {
    jest.useFakeTimers();
    try {
      const raw = { ...match, competition: { ...match.competition, code: 'BSA' } };
      const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async url =>
        new Response(JSON.stringify(String(url).includes('/matches/123') ? raw : { matches: [raw] }), { status: 200 }));
      const client = new FootballDataClient({ get: () => 'test-token' } as unknown as ConfigService);
      await client.pesquisarPartidasPorPeriodo('2030-10-03', '2030-10-03');
      const oficial = client.buscarPartidasPorIds([123]);
      await jest.advanceTimersByTimeAsync(6500);
      await oficial;
      await jest.advanceTimersByTimeAsync(30001);
      await client.pesquisarPartidasPorPeriodo('2030-10-03', '2030-10-03');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { jest.useRealTimers(); }
  });

  it('nao armazena falha do provider como lista vazia', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ matches: [] }), { status: 200 }));
      const client = new FootballDataClient({ get: () => 'test-token' } as unknown as ConfigService);
      await expect(client.pesquisarPartidasPorPeriodo('2030-10-03', '2030-10-03')).rejects.toMatchObject({ code: 'RATE_LIMIT' });
      const nova = client.pesquisarPartidasPorPeriodo('2030-10-03', '2030-10-03');
      await jest.advanceTimersByTimeAsync(6500);
      await expect(nova).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('distingue horario confirmado de data provisoria e normaliza escudo opcional', () => {
    expect(mapDesafioMatch(match)).toMatchObject({ fixtureId: 123, horarioConfirmado: true, statusInterno: 'AGENDADA', visitanteLogo: null });
    expect(mapDesafioMatch({ ...match, status: 'SCHEDULED' }).horarioConfirmado).toBe(false);
    expect(mapDesafioMatch({ ...match, status: 'FINISHED' }).statusInterno).toBe('FINALIZADA');
  });

  it('rejeita listas incompletas, IDs duplicados e adversarios iguais', () => {
    expect(() => parseDesafioMatches({ matches: [match], resultSet: { count: 2 } })).toThrow();
    expect(() => parseDesafioMatches({ matches: [match, match] })).toThrow();
    expect(() => mapDesafioMatch({ ...match, awayTeam: match.homeTeam })).toThrow();
  });

  it('consulta intervalo inclusivo com token e remove partidas fora do periodo', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ matches: [match,
      { ...match, id: 124, utcDate: '2030-10-04T00:00:00Z' }] }), { status: 200 }));
    const client = new FootballDataClient({ get: () => 'test-token' } as unknown as ConfigService);
    expect(await client.pesquisarPartidas({ date: '2030-10-03' })).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.football-data.org/v4/matches?dateFrom=2030-10-03&dateTo=2030-10-04',
      expect.objectContaining({ headers: { 'X-Auth-Token': 'test-token' } }));
  });

  it('distingue partida inexistente de indisponibilidade', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(new Response('', { status: 503 }));
    const config = { get: () => 'test-token' } as unknown as ConfigService;
    await expect(new FootballDataClient(config).buscarPartidasPorIds([123])).resolves.toEqual([]);
    await expect(new FootballDataClient(config).buscarPartidasPorIds([123])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
