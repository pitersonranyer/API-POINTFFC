import { ConfigService } from '@nestjs/config';
import { FootballDataClient } from '../src/futebol/football-data.client';
import { mapDesafioMatch, parseDesafioMatches } from '../src/futebol/football-data.normalizer';

const match = { id: 123, competition: { id: 2013, name: 'Serie A' }, utcDate: '2030-10-03T16:00:00Z',
  status: 'TIMED', homeTeam: { id: 1, name: 'A', crest: 'https://example.com/a.png' }, awayTeam: { id: 2, name: 'B' } };

describe('football-data para Desafios', () => {
  afterEach(() => jest.restoreAllMocks());

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
