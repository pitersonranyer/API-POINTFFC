import { CartolaCacheService } from '../src/cartola/cartola-cache.service';
import { CartolaHttpClient } from '../src/cartola/cartola-http.client';
import { CartolaService } from '../src/cartola/cartola.service';
import { CartolaMarketStatus, CartolaMatchesResponse } from '../src/cartola/cartola.types';

describe('CartolaService', () => {
  let get: jest.Mock;
  let service: CartolaService;

  const status = (status_mercado: number, bola_rolando: boolean): CartolaMarketStatus => ({
    rodada_atual: 25, status_mercado, bola_rolando,
  });
  const matches: CartolaMatchesResponse = { rodada: 25, clubes: {}, partidas: [{ partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2 }] };

  beforeEach(() => {
    jest.useFakeTimers();
    get = jest.fn((path: string) => {
      if (path === '/mercado/status') return Promise.resolve(status(1, false));
      if (path === '/partidas' || path.startsWith('/partidas/')) return Promise.resolve(matches);
      return Promise.resolve({});
    });
    service = new CartolaService({ get } as unknown as CartolaHttpClient, new CartolaCacheService());
  });

  afterEach(() => jest.useRealTimers());

  it('preserva status original e considera aberto somente status_mercado 1', async () => {
    get.mockResolvedValueOnce({ ...status(1, false), campo_extra: 'preservado' });
    expect((await service.getMarketStatus()).value).toMatchObject({ status_mercado: 1, campo_extra: 'preservado' });
  });

  it('usa cache longo de atletas de mercado enquanto fechado', async () => {
    get.mockImplementation((path: string) => Promise.resolve(path === '/mercado/status' ? status(2, false) : { atletas: [] }));
    await service.getMarketAthletes();
    jest.advanceTimersByTime(59 * 60 * 1000);
    await service.getMarketAthletes();
    expect(get.mock.calls.filter(([path]) => path === '/atletas/mercado')).toHaveLength(1);
  });

  it('atualiza atletas pontuados rapidamente com bola rolando', async () => {
    get.mockImplementation((path: string) => Promise.resolve(path === '/mercado/status' ? status(2, true) : { atletas: [] }));
    await service.getScoredAthletes(25);
    jest.advanceTimersByTime(15001);
    await service.getScoredAthletes(25);
    expect(get.mock.calls.filter(([path]) => path === '/atletas/pontuados/25')).toHaveLength(2);
  });

  it('exige a rodada para atletas pontuados quando o mercado está aberto', async () => {
    await expect(service.getScoredAthletes()).rejects.toThrow('Informe a rodada');
    expect(get.mock.calls.filter(([path]) => path.startsWith('/atletas/pontuados'))).toHaveLength(0);
  });

  it('usa o endpoint sem rodada quando o mercado está fechado', async () => {
    get.mockImplementation((path: string) => Promise.resolve(path === '/mercado/status' ? status(2, false) : { atletas: [] }));
    await service.getScoredAthletes();
    expect(get).toHaveBeenCalledWith('/atletas/pontuados');
  });

  it('mantém bola rolando independente do estado fechado no dashboard', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/mercado/status') return Promise.resolve(status(2, true));
      if (path === '/partidas') return Promise.resolve(matches);
      return Promise.resolve({ 1: { nome: 'Clube' } });
    });
    const dashboard = (await service.getDashboard()).value;
    expect(dashboard).toMatchObject({ rodada: 25, mercadoAberto: false, bolaRolando: true, partidas: matches.partidas });
  });

  it('reutiliza caches no dashboard sem duplicar chamadas externas', async () => {
    await service.getMarketStatus();
    await service.getMatches();
    await service.getClubs();
    const callsBefore = get.mock.calls.length;
    await service.getDashboard();
    expect(get).toHaveBeenCalledTimes(callsBefore);
  });

  it('mantém cache longo para rodada passada', async () => {
    await service.getMatchesByRound(24);
    jest.advanceTimersByTime(23 * 60 * 60 * 1000);
    await service.getMatchesByRound(24);
    expect(get.mock.calls.filter(([path]) => path === '/partidas/24')).toHaveLength(1);
  });
});
