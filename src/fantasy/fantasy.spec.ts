import { BadRequestException } from '@nestjs/common';
import { ApiFootballClient } from './api-football.client';
import { mapSumario } from './api-football.mapper';
import { FantasyController } from './fantasy.controller';
import { FantasyService } from './fantasy.service';
import { ApiEvent, ApiFixture } from './fantasy.types';

const fixture: ApiFixture = {
  fixture: { id: 1180729, date: '2024-12-08T19:00:00+00:00', status: { short: 'FT' }, venue: { name: 'Estádio' } },
  league: { name: 'Serie A', round: 'Regular Season - 38' },
  teams: { home: { id: 120, name: 'Botafogo', logo: 'home.png' }, away: { id: 126, name: 'Sao Paulo', logo: 'away.png' } },
  goals: { home: 2, away: 1 },
};
function event(overrides: Partial<ApiEvent> = {}): ApiEvent {
  return { time: { elapsed: 37, extra: null }, team: fixture.teams.home,
    player: { id: 1, name: 'Savarino' }, assist: { id: 2, name: 'Assistente' },
    type: 'Goal', detail: 'Normal Goal', comments: null, ...overrides };
}

describe('Mapper do sumário Fantasy', () => {
  it('normaliza cabeçalho, gol, assistência e placar', () => {
    const result = mapSumario(fixture, [event()]);
    expect(result.partida).toMatchObject({ idExterno: 1180729, rodada: 38, status: 'ENCERRADA', placar: { mandante: 2, visitante: 1 } });
    expect(result.eventos[0]).toMatchObject({ tipo: 'GOL', jogador: { idExterno: 1, nome: 'Savarino' },
      assistencia: { idExterno: 2, nome: 'Assistente' }, placarAposEvento: { mandante: 1, visitante: 0 } });
  });
  it('normaliza saída/entrada sem assistência na substituição', () => {
    const result = mapSumario(fixture, [event({ type: 'subst', detail: 'Substitution 1' })]).eventos[0];
    expect(result).toMatchObject({ tipo: 'SUBSTITUICAO', jogadorSai: { idExterno: 1 }, jogadorEntra: { idExterno: 2 } });
    expect(result).not.toHaveProperty('assistencia');
    expect(result).not.toHaveProperty('jogador');
  });
  it('normaliza cartão e preserva comentários sem tradução', () => {
    expect(mapSumario(fixture, [event({ type: 'Card', detail: 'Yellow Card', comments: 'Foul' })]).eventos[0])
      .toMatchObject({ tipo: 'CARTAO_AMARELO', comentarios: 'Foul', jogador: { idExterno: 1 } });
  });
  it('VAR não incrementa placar e ordena os gols cronologicamente', () => {
    const result = mapSumario(fixture, [event({ time: { elapsed: 90, extra: 2 }, player: { id: 3, name: 'Gregore' } }),
      event({ time: { elapsed: 63, extra: null }, team: fixture.teams.away, player: { id: 4, name: 'William' } }),
      event({ type: 'Var', detail: 'Goal cancelled', time: { elapsed: 40, extra: null } }), event()]);
    expect(result.eventos.map(e => e.tipo)).toEqual(['GOL', 'VAR_GOL_ANULADO', 'GOL', 'GOL']);
    expect(result.eventos[1]).not.toHaveProperty('placarAposEvento');
    expect(result.eventos.filter(e => e.tipo === 'GOL').map(e => e.placarAposEvento)).toEqual([
      { mandante: 1, visitante: 0 }, { mandante: 1, visitante: 1 }, { mandante: 2, visitante: 1 },
    ]);
    expect(result.eventos[3].tempo).toEqual({ minuto: 90, acrescimo: 2, exibicao: "90+2'" });
  });
  it('ordena 90+3/90+7/90+4 e mantém empates estáveis sem mutar a entrada', () => {
    const rows = [3, 7, 4, 4].map((extra, i) => event({ time: { elapsed: 90, extra }, comments: String(i) }));
    expect(mapSumario(fixture, rows).eventos.map(e => e.comentarios)).toEqual(['0', '2', '3', '1']);
    expect(rows.map(e => e.time.extra)).toEqual([3, 7, 4, 4]);
  });
  it('tolera tipo/detalhe desconhecido sem incrementar placar', () => {
    const result = mapSumario(fixture, [event({ type: 'New', detail: 'Future detail' }), event({ detail: 'Missed Penalty' }), event()]);
    expect(result.eventos[0]).toMatchObject({ tipo: 'DESCONHECIDO', origem: { tipo: 'New', detalhe: 'Future detail' } });
    expect(result.eventos[1]).not.toHaveProperty('placarAposEvento');
    expect(result.eventos[2].placarAposEvento).toEqual({ mandante: 1, visitante: 0 });
  });
  it('preserva nulos, minuto simples e rodada não numérica', () => {
    const result = mapSumario({ ...fixture, league: { name: 'Copa', round: 'Final' }, goals: { home: null, away: null } },
      [event({ assist: { id: null, name: null } }), event({ time: { elapsed: null, extra: null } })]);
    expect(result.partida.rodada).toBeNull();
    expect(result.partida.placar).toEqual({ mandante: null, visitante: null });
    expect(result.eventos[0].tempo.exibicao).toBeNull();
    expect(result.eventos[1]).toMatchObject({ assistencia: null, tempo: { exibicao: "37'" } });
  });
});

describe('FantasyService e controller', () => {
  const client = { fixture: jest.fn(), events: jest.fn() };
  const service = new FantasyService(client as unknown as ApiFootballClient);
  const controller = new FantasyController(service);
  beforeEach(() => { jest.clearAllMocks(); client.fixture.mockResolvedValue(fixture); client.events.mockResolvedValue([]); });
  it.each(['0', '-1', '1.5', 'abc', '1e3', ' 1', '1 ', '+1', '', '9007199254740992'])('rejeita %p antes do provider', async id => {
    await expect(controller.sumario(id)).rejects.toBeInstanceOf(BadRequestException);
    expect(client.fixture).not.toHaveBeenCalled(); expect(client.events).not.toHaveBeenCalled();
  });
  it('consulta apenas fixture e eventos pelo ID informado', async () => {
    await expect(controller.sumario('1180729')).resolves.toHaveProperty('eventos', []);
    expect(client.fixture).toHaveBeenCalledWith(1180729); expect(client.events).toHaveBeenCalledWith(1180729);
  });
  it('não consulta eventos quando fixture não existe', async () => {
    client.fixture.mockRejectedValueOnce(new Error('not found'));
    await expect(service.sumario('1')).rejects.toThrow('not found');
    expect(client.events).not.toHaveBeenCalled();
  });
});
