import { BadGatewayException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CartolaCacheService } from '../src/cartola/cartola-cache.service';
import { CartolaHttpClient } from '../src/cartola/cartola-http.client';
import { CartolaService } from '../src/cartola/cartola.service';

describe('CartolaService - times', () => {
  let get: jest.Mock;
  let service: CartolaService;

  beforeEach(() => {
    get = jest.fn();
    service = new CartolaService({ get } as unknown as CartolaHttpClient, new CartolaCacheService());
  });

  it('busca por ID e reutiliza o cache', async () => {
    get.mockResolvedValue({ time_id: 123, nome: 'Time A', campo_extra: true });
    const first = await service.getTeamById(123);
    const second = await service.getTeamById(123);
    expect(first.value).toMatchObject({ time_id: 123, campo_extra: true });
    expect(second.cache).toBe('hit');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/time/id/123', { notFoundMessage: 'Time do Cartola não encontrado' });
  });

  it('ignora o cache quando forceRefresh é solicitado', async () => {
    get.mockResolvedValue({ time_id: 123, nome: 'Time fresco' });
    await service.getTeamById(123);
    const fresh = await service.getTeamById(123, { forceRefresh: true });

    expect(fresh).toMatchObject({ cache: 'miss', stale: false, value: { nome: 'Time fresco' } });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('busca nome escapado, retorna múltiplos resultados e normaliza a chave de cache', async () => {
    get.mockResolvedValue([{ time_id: 1 }, { time_id: 2 }]);
    expect((await service.searchTeams(' Meu Time ')).value).toHaveLength(2);
    expect((await service.searchTeams('meu time')).cache).toBe('hit');
    expect(get).toHaveBeenCalledWith('/times?q=Meu%20Time');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('retorna encontrados, ausentes e falhas externas sem derrubar o lote', async () => {
    get.mockImplementation((path: string) => {
      if (path.endsWith('/123')) return Promise.resolve({ time: { time_id: 123, nome: 'Time A', nome_cartola: 'Pessoa', campo_extra: 'ok' }, atletas: [{ atleta_id: 1 }] });
      if (path.endsWith('/999')) return Promise.reject(new NotFoundException());
      if (path.endsWith('/456')) return Promise.reject(new ServiceUnavailableException());
      return Promise.reject(new BadGatewayException());
    });
    const result = (await service.getTeamsByIds([123, 999, 456, 789])).value;
    expect(result).toMatchObject({ solicitados: 4, encontrados: 1, naoEncontrados: 1, idsNaoEncontrados: [999] });
    expect(result.times[0]).toMatchObject({ timeId: 123, nome: 'Time A', cartoleiro: 'Pessoa', campo_extra: 'ok' });
    expect(result.times[0]).not.toHaveProperty('atletas');
    expect(result.erros).toEqual([{ timeId: 456, tipo: 'timeout' }, { timeId: 789, tipo: 'api_indisponivel' }]);
  });

  it('limita a cinco chamadas simultâneas e preserva a ordem da entrada', async () => {
    let active = 0;
    let maximum = 0;
    get.mockImplementation(async (path: string) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const timeId = Number(path.split('/').pop());
      return { time_id: timeId, nome: `Time ${timeId}` };
    });
    const ids = Array.from({ length: 12 }, (_, index) => index + 1);
    const result = (await service.getTeamsByIds(ids)).value;
    expect(maximum).toBe(5);
    expect(result.times.map((team) => team.timeId)).toEqual(ids);
  });
});
