import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiFootballClient } from './api-football.client';
import { mapEstatisticas } from './api-football.mapper';
import { FantasyController } from './fantasy.controller';
import { FantasyService } from './fantasy.service';
import { ApiFixture, ApiTeamStatistics } from './fantasy.types';

const fixture: ApiFixture = {
  fixture: { id: 1180729, date: '2024-12-08T19:00:00+00:00', status: { short: 'FT' }, venue: { name: 'Estádio Nilton Santos' } },
  league: { name: 'Serie A', round: 'Regular Season - 38' },
  teams: { home: { id: 120, name: 'Botafogo', logo: 'home.png' }, away: { id: 126, name: 'Sao Paulo', logo: 'away.png' } },
  goals: { home: 2, away: 1 },
};
function row(statistics: ApiTeamStatistics['statistics'], away = false): ApiTeamStatistics {
  return { team: away ? fixture.teams.away : fixture.teams.home, statistics };
}
const observed = row([
  { type: 'Shots on Goal', value: 8 }, { type: 'Shots off Goal', value: 8 },
  { type: 'Total Shots', value: 17 }, { type: 'Blocked Shots', value: 1 },
  { type: 'Shots insidebox', value: 10 }, { type: 'Shots outsidebox', value: 7 },
  { type: 'Fouls', value: 8 }, { type: 'Corner Kicks', value: 3 }, { type: 'Offsides', value: 1 },
  { type: 'Ball Possession', value: '46%' }, { type: 'Yellow Cards', value: null }, { type: 'Red Cards', value: null },
  { type: 'Goalkeeper Saves', value: 0 }, { type: 'Total passes', value: 504 },
  { type: 'Passes accurate', value: 466 }, { type: 'Passes %', value: '92%' },
  { type: 'expected_goals', value: '1.88' }, { type: 'goals_prevented', value: '0.50' },
]);

describe('Mapper de estatísticas Fantasy', () => {
  it('normaliza todos os 18 campos observados, incluindo zero, null, percentuais e decimais', () => {
    expect(mapEstatisticas(fixture, [observed]).mandante.estatisticas).toEqual({
      finalizacoesNoGol: 8, finalizacoesFora: 8, finalizacoes: 17, finalizacoesBloqueadas: 1,
      finalizacoesDentroArea: 10, finalizacoesForaArea: 7, faltas: 8, escanteios: 3, impedimentos: 1,
      posseBola: 46, cartoesAmarelos: null, cartoesVermelhos: null, defesasGoleiro: 0,
      passes: 504, passesCertos: 466, precisaoPasses: 92, golsEsperados: 1.88, golsEvitados: 0.5,
    });
  });
  it('associa por ID com ordem invertida e usa metadados do fixture', () => {
    const visitor = row([{ type: 'Total Shots', value: 5 }], true);
    const result = mapEstatisticas(fixture, [visitor, { ...observed, team: { ...observed.team, name: 'Outro rótulo' } }]);
    expect(result.partida).toEqual({ idExterno: 1180729 });
    expect(result.mandante).toMatchObject({ idExterno: 120, nome: 'Botafogo', logo: 'home.png', estatisticas: { finalizacoes: 17 } });
    expect(result.visitante).toMatchObject({ idExterno: 126, nome: 'Sao Paulo', estatisticas: { finalizacoes: 5 } });
  });
  it('sem estatísticas retorna os 18 campos null para ambas as equipes', () => {
    const result = mapEstatisticas(fixture, []);
    expect(Object.keys(result.mandante.estatisticas)).toHaveLength(18);
    expect(Object.values(result.mandante.estatisticas).every(value => value === null)).toBe(true);
    expect(result.visitante.estatisticas).toEqual(result.mandante.estatisticas);
    expect(mapEstatisticas(fixture, [row([])]).mandante.estatisticas).toEqual(result.mandante.estatisticas);
  });
  it('uma equipe ausente fica com null sem copiar estatísticas do adversário', () => {
    const result = mapEstatisticas(fixture, [row([{ type: 'Total Shots', value: 5 }], true)]);
    expect(result.mandante.estatisticas.finalizacoes).toBeNull();
    expect(result.visitante.estatisticas.finalizacoes).toBe(5);
  });
  it('ignora estatística desconhecida sem expor nomes do provider ou mutar a entrada', () => {
    const unknown = row([{ type: 'Future metric', value: 'not numeric' }, ...observed.statistics]);
    const before = JSON.stringify(unknown);
    const result = mapEstatisticas(fixture, [unknown]);
    expect(result.mandante.estatisticas).toEqual(mapEstatisticas(fixture, [observed]).mandante.estatisticas);
    expect(JSON.stringify(result)).not.toContain('Future metric');
    expect(JSON.stringify(unknown)).toBe(before);
  });
  it.each([55, '55%', '55', '55.5%', ' 55% ', 0, '0%'])('normaliza percentual %p na escala 0–100', value => {
    const result = mapEstatisticas(fixture, [row([{ type: 'Ball Possession', value }])]);
    expect(result.mandante.estatisticas.posseBola).toBe(Number(String(value).trim().replace('%', '')));
  });
  it('preserva null de percentual e aceita decimal assinado de gols evitados', () => {
    const result = mapEstatisticas(fixture, [row([{ type: 'Ball Possession', value: null }, { type: 'goals_prevented', value: '-0.50' }])]);
    expect(result.mandante.estatisticas.posseBola).toBeNull();
    expect(result.mandante.estatisticas.golsEvitados).toBe(-0.5);
  });
  it('aceita contagem numérica textual sem transformar string vazia em zero', () => {
    expect(mapEstatisticas(fixture, [row([{ type: 'Total Shots', value: '17' }])]).mandante.estatisticas.finalizacoes).toBe(17);
  });
  it.each(['', ' ', '8 shots', '8%', '1e2', 'NaN', -1, 1.5, Infinity, NaN, '9007199254740992'])('rejeita contagem inválida %p com erro controlado', value => {
    expect(() => mapEstatisticas(fixture, [row([{ type: 'Total Shots', value }])])).toThrow(BadGatewayException);
  });
  it.each(['101%', '-1%', '55%%', 'invalid', Infinity])('rejeita percentual inválido %p', value => {
    expect(() => mapEstatisticas(fixture, [row([{ type: 'Ball Possession', value }])])).toThrow(BadGatewayException);
  });
  it.each(['1.88x', '-1', '0x10'])('rejeita decimal inválido de xG %p', value => {
    expect(() => mapEstatisticas(fixture, [row([{ type: 'expected_goals', value }])])).toThrow(BadGatewayException);
  });
  it('rejeita equipe estranha, duplicada e estatística conhecida duplicada', () => {
    expect(() => mapEstatisticas(fixture, [{ ...observed, team: { ...observed.team, id: 999 } }])).toThrow(BadGatewayException);
    expect(() => mapEstatisticas(fixture, [observed, observed])).toThrow(BadGatewayException);
    expect(() => mapEstatisticas(fixture, [row([{ type: 'Total Shots', value: 1 }, { type: 'Total Shots', value: 2 }])])).toThrow(BadGatewayException);
  });
});

describe('Estatísticas — service e controller', () => {
  const client = { fixture: jest.fn(), statistics: jest.fn(), events: jest.fn() };
  const controller = new FantasyController(new FantasyService(client as unknown as ApiFootballClient));
  beforeEach(() => { jest.clearAllMocks(); client.fixture.mockResolvedValue(fixture); client.statistics.mockResolvedValue([observed]); });
  it.each(['0', '-1', '1.5', 'abc', '1e3', ' 1', '1 ', '+1', '', '9007199254740992'])('rejeita %p sem consultar provider', async id => {
    await expect(controller.estatisticas(id)).rejects.toBeInstanceOf(BadRequestException);
    expect(client.fixture).not.toHaveBeenCalled(); expect(client.statistics).not.toHaveBeenCalled();
    expect(client.events).not.toHaveBeenCalled();
  });
  it('consulta fixture e statistics pelo ID sem consultar sumário/eventos', async () => {
    await expect(controller.estatisticas('1180729')).resolves.toMatchObject({ mandante: { estatisticas: { finalizacoes: 17 } } });
    expect(client.fixture).toHaveBeenCalledTimes(1); expect(client.fixture).toHaveBeenCalledWith(1180729);
    expect(client.statistics).toHaveBeenCalledTimes(1); expect(client.statistics).toHaveBeenCalledWith(1180729);
    expect(client.events).not.toHaveBeenCalled();
  });
  it('fixture inexistente retorna 404 sem consultar statistics', async () => {
    client.fixture.mockRejectedValueOnce(new NotFoundException('Partida não encontrada'));
    await expect(controller.estatisticas('1')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.statistics).not.toHaveBeenCalled();
  });
  it('fixture existente sem estatísticas mantém contrato com null', async () => {
    client.statistics.mockResolvedValueOnce([]);
    await expect(controller.estatisticas('1180729')).resolves.toMatchObject({ mandante: { estatisticas: { finalizacoes: null } } });
  });
});
