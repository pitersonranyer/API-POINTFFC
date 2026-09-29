import { ConfigService } from '@nestjs/config';
import { FootballDataClient } from '../src/futebol/football-data.client';
import { mapDesafioResultado } from '../src/futebol/football-data-desafio-resultado';

const match = (score: unknown, status = 'FINISHED') => ({ id: 100, status, utcDate: '2030-10-01T12:00:00Z',
  competition: { id: 2013, name: 'Serie A' }, homeTeam: { id: 1, name: 'Casa' }, awayTeam: { id: 2, name: 'Fora' }, score });

describe('football-data: resultado seguro de 90 minutos', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([[2, 0, 'CASA'], [0, 0, 'EMPATE'], [1, 3, 'FORA']])('REGULAR %s x %s = %s', (home, away, resultado) => {
    expect(mapDesafioResultado(match({ duration: 'REGULAR', fullTime: { home, away } }))).toMatchObject({
      statusApuracao: 'FINALIZADA', resultado, golsMandante: home, golsVisitante: away, pendencia: null,
    });
  });

  it.each(['EXTRA_TIME', 'PENALTY_SHOOTOUT'])('usa regularTime e ignora fullTime/winner/%s', duration => {
    expect(mapDesafioResultado(match({ duration, winner: 'HOME_TEAM', fullTime: { home: 7, away: 6 },
      regularTime: { home: 1, away: 1 }, extraTime: { home: 1, away: 0 }, penalties: { home: 5, away: 4 } })))
      .toMatchObject({ statusApuracao: 'FINALIZADA', resultado: 'EMPATE', golsMandante: 1, golsVisitante: 1 });
  });

  it.each([null, {}, { fullTime: { home: 2, away: 1 } },
    { duration: 'REGULAR', fullTime: { home: null, away: 0 } },
    { duration: 'REGULAR', fullTime: { home: '2', away: 0 } },
    { duration: 'REGULAR', fullTime: { home: -1, away: 0 } },
    { duration: 'REGULAR', fullTime: { home: 1.5, away: 0 } },
    { duration: 'REGULAR', fullTime: { home: 2, away: 0 }, regularTime: { home: 1, away: 0 } },
    { duration: 'EXTRA_TIME', fullTime: { home: 2, away: 0 } },
    { duration: 'PENALTY_SHOOTOUT', fullTime: { home: 7, away: 6 }, regularTime: { home: null, away: null } },
    { duration: 'UNKNOWN', fullTime: { home: 2, away: 1 } },
  ])('nao inventa resultado para score incompleto/ambiguo: %j', score => {
    expect(mapDesafioResultado(match(score))).toMatchObject({ statusApuracao: 'EM_ANDAMENTO', resultado: null,
      golsMandante: null, golsVisitante: null, pendencia: 'PLACAR_90_MINUTOS_INDISPONIVEL' });
  });

  it.each([['SCHEDULED', 'AGENDADA'], ['TIMED', 'AGENDADA'], ['IN_PLAY', 'EM_ANDAMENTO'], ['PAUSED', 'EM_ANDAMENTO'],
    ['EXTRA_TIME', 'EM_ANDAMENTO'], ['PENALTY_SHOOTOUT', 'EM_ANDAMENTO'], ['POSTPONED', 'ANULADA'],
    ['CANCELLED', 'ANULADA'], ['SUSPENDED', 'ANULADA'], ['AWARDED', 'ANULADA']])
  ('traduz %s para %s sem pontuar placar parcial/administrativo', (status, statusApuracao) => {
    expect(mapDesafioResultado(match({ duration: 'REGULAR', fullTime: { home: 2, away: 1 } }, status)))
      .toMatchObject({ statusApuracao, resultado: null, golsMandante: null, golsVisitante: null });
  });

  it('status desconhecido permanece pendente, nunca anulado/finalizado', () => {
    expect(mapDesafioResultado(match(null, 'NEW_STATUS'))).toMatchObject({ statusApuracao: 'EM_ANDAMENTO', pendencia: 'STATUS_NAO_SUPORTADO' });
  });

  it('cliente existente consulta lote por IDs e preserva score para a apuracao', async () => {
    const raw = match({ duration: 'PENALTY_SHOOTOUT', regularTime: { home: 1, away: 1 }, fullTime: { home: 7, away: 6 } });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ matches: [raw, { ...raw, id: 101 }] })));
    const config = { get: () => 'test-token' } as unknown as ConfigService;
    const result = await new FootballDataClient(config).buscarResultadosPorIds([100, 101]);
    expect(result.map(r => r.resultado)).toEqual(['EMPATE', 'EMPATE']);
    expect(fetchMock).toHaveBeenCalledWith('https://api.football-data.org/v4/matches?ids=100%2C101', expect.any(Object));
  });
});
