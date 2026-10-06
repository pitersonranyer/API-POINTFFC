import { BadGatewayException, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiFootballClient } from './api-football.client';
import { mapFormacao } from './api-football.mapper';
import { FantasyController } from './fantasy.controller';
import { FantasyService } from './fantasy.service';
import { ApiFixture } from './fantasy.types';

const fixture: ApiFixture = {
  fixture: { id: 1180729, date: '2024-12-08T19:00:00+00:00', status: { short: 'FT' }, venue: { name: 'Estádio Nilton Santos' } },
  league: { name: 'Serie A', round: 'Regular Season - 38' },
  teams: { home: { id: 120, name: 'Botafogo', logo: 'home.png' }, away: { id: 126, name: 'Sao Paulo', logo: 'away.png' } },
  goals: { home: 2, away: 1 },
};
const john = { id: 70366, name: 'John', number: 12, pos: 'G', grid: '1:1' };
const gregore = { id: 10031, name: 'Gregore', number: 26, pos: 'D', grid: '2:3' };
const home = {
  team: fixture.teams.home, formation: '3-3-1-3',
  coach: { id: 12089, name: 'Artur Jorge', photo: 'coach.png' },
  startXI: [{ player: john }, { player: gregore }],
  substitutes: [
    { player: { id: 326, name: 'Allan', number: 28, pos: 'M', grid: null } },
    { player: { id: 390, name: 'Tiquinho Soares', number: 9, pos: 'F', grid: null } },
  ],
};
const away = {
  team: fixture.teams.away, formation: '3-4-1-2', coach: { id: 846, name: 'L. Zubeldía', photo: null },
  startXI: [{ player: { id: 30763, name: 'Jandrei', number: 93, pos: 'G', grid: '1:1' } }], substitutes: [],
};

describe('Mapper de formação', () => {
  it('response[0] NÃO é assumido como mandante: associa por ID com array invertido', () => {
    const result = mapFormacao(fixture, [away, home]);
    expect(result.partida).toEqual({ idExterno: 1180729 });
    expect(result.mandante).toMatchObject({ idExterno: 120, nome: 'Botafogo', logo: 'home.png', formacao: '3-3-1-3' });
    expect(result.visitante).toMatchObject({ idExterno: 126, nome: 'Sao Paulo', formacao: '3-4-1-2' });
    expect(result.mandante.titulares[0]).toEqual({ idExterno: 70366, nome: 'John', numero: 12, posicao: 'G', grid: '1:1' });
    expect(result.visitante.titulares[0].nome).toBe('Jandrei');
  });
  it('normaliza treinador com foto null e separa titulares de reservas', () => {
    const result = mapFormacao(fixture, [home, away]);
    expect(result.mandante.treinador).toEqual({ idExterno: 12089, nome: 'Artur Jorge', foto: 'coach.png' });
    expect(result.visitante.treinador).toEqual({ idExterno: 846, nome: 'L. Zubeldía', foto: null });
    expect(result.mandante.reservas[0]).toEqual({ idExterno: 326, nome: 'Allan', numero: 28, posicao: 'M', grid: null });
    expect(result.mandante.titulares.map(p => p.nome)).toEqual(['John', 'Gregore']);
  });
  it('preserva ordem dos dois grupos sem ordenar por nome, camisa ou grid e sem mutar', () => {
    const before = JSON.stringify(home);
    const result = mapFormacao(fixture, [home]);
    expect(result.mandante.titulares.map(p => p.idExterno)).toEqual([70366, 10031]);
    expect(result.mandante.reservas.map(p => p.numero)).toEqual([28, 9]);
    expect(JSON.stringify(home)).toBe(before);
  });
  it('aceita jogador identificado só por ID sem inventar atributos', () => {
    const result = mapFormacao(fixture, [{ team: { id: 120 }, startXI: [{ player: { id: 1 } }] }]);
    expect(result.mandante.titulares[0]).toEqual({ idExterno: 1, nome: null, numero: null, posicao: null, grid: null });
    expect(result.mandante.formacao).toBeNull(); expect(result.mandante.treinador).toBeNull();
    expect(result.mandante.reservas).toEqual([]);
  });
  it('preserva número zero, formação incomum, posição desconhecida e grid factual sem inferência', () => {
    const result = mapFormacao(fixture, [{ ...home, formation: 'incomum', startXI: [
      { player: { ...john, number: 0, pos: 'NEW', grid: 'provider-grid' } },
    ] }]);
    expect(result.mandante.formacao).toBe('incomum');
    expect(result.mandante.titulares[0]).toMatchObject({ numero: 0, posicao: 'NEW', grid: 'provider-grid' });
  });
  it('preserva número/grid null sem inferir posição a partir do grid', () => {
    const result = mapFormacao(fixture, [{ ...home, startXI: [{ player: { ...john, number: null, grid: null, pos: null } }] }]);
    expect(result.mandante.titulares[0]).toMatchObject({ numero: null, grid: null, posicao: null });
  });
  it.each([undefined, null, {}, { id: null, name: null, photo: null }])('treinador ausente %p é null', coach => {
    expect(mapFormacao(fixture, [{ ...home, coach }]).mandante.treinador).toBeNull();
  });
  it('treinador parcialmente informado mantém os dados disponíveis', () => {
    expect(mapFormacao(fixture, [{ ...home, coach: { name: 'Treinador' } }]).mandante.treinador)
      .toEqual({ idExterno: null, nome: 'Treinador', foto: null });
  });
  it.each([undefined, null])('formação ausente %p é null', formation => {
    expect(mapFormacao(fixture, [{ ...home, formation }]).mandante.formacao).toBeNull();
  });
  it('fixture sem lineup retorna as equipes com null e arrays vazios', () => {
    const result = mapFormacao(fixture, []);
    for (const team of [result.mandante, result.visitante]) {
      expect(team).toMatchObject({ formacao: null, treinador: null, titulares: [], reservas: [] });
    }
    expect(result.mandante.idExterno).toBe(120); expect(result.visitante.idExterno).toBe(126);
  });
  it('lineup parcial ou grupos vazios/null não copiam dados do adversário', () => {
    expect(mapFormacao(fixture, [home]).visitante).toMatchObject({ formacao: null, treinador: null, titulares: [], reservas: [] });
    expect(mapFormacao(fixture, [{ ...home, startXI: [], substitutes: null }]).mandante)
      .toMatchObject({ titulares: [], reservas: [] });
  });
  it.each([null, {}, { team: null }, { team: { id: null } }, { team: { id: 999 } },
    { ...home, startXI: {} }, { ...home, startXI: [null] }, { ...home, startXI: [{ player: null }] },
    { ...home, substitutes: 'invalid' }, { ...home, formation: 433 }, { ...home, coach: 'invalid' },
  ])('rejeita payload estrutural/essencial inválido %p', row => {
    expect(() => mapFormacao(fixture, [row])).toThrow(BadGatewayException);
  });
  it.each([null, 0, -1, 1.5, '123', 9007199254740992])('rejeita ID essencial inválido %p', id => {
    expect(() => mapFormacao(fixture, [{ ...home, startXI: [{ player: { ...john, id } }] }])).toThrow(BadGatewayException);
  });
  it.each([{ number: '12' }, { number: -1 }, { number: 1.5 }, { name: 123 }, { pos: {} }, { grid: 11 }])('rejeita atributo informado inválido %p', change => {
    expect(() => mapFormacao(fixture, [{ ...home, startXI: [{ player: { ...john, ...change } }] }])).toThrow(BadGatewayException);
  });
  it('rejeita IDs duplicados de equipe e jogador, inclusive entre grupos', () => {
    expect(() => mapFormacao(fixture, [home, home])).toThrow(BadGatewayException);
    expect(() => mapFormacao(fixture, [{ ...home, startXI: [{ player: john }, { player: john }] }])).toThrow(BadGatewayException);
    expect(() => mapFormacao(fixture, [{ ...home, substitutes: [{ player: john }] }])).toThrow(BadGatewayException);
  });
  it('rejeita fixture inválido e fixture com equipes ambíguas', () => {
    expect(() => mapFormacao({ ...fixture, fixture: { ...fixture.fixture, id: 0 } }, [])).toThrow(BadGatewayException);
    expect(() => mapFormacao({ ...fixture, teams: { home: fixture.teams.home, away: fixture.teams.home } }, [])).toThrow(BadGatewayException);
  });
});

describe('Formação — service e controller', () => {
  const client = { fixture: jest.fn(), lineups: jest.fn(), statistics: jest.fn(), events: jest.fn() };
  const controller = new FantasyController(new FantasyService(client as unknown as ApiFootballClient));
  beforeEach(() => { jest.clearAllMocks(); client.fixture.mockResolvedValue(fixture); client.lineups.mockResolvedValue([away, home]); });
  it.each(['0', '-1', '1.5', 'abc', '1e3', ' 1', '1 ', '+1', '', '9007199254740992'])('rejeita %p antes de qualquer provider', async id => {
    await expect(controller.formacao(id)).rejects.toBeInstanceOf(BadRequestException);
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
  });
  it('consulta somente fixture e lineups por ID', async () => {
    await expect(controller.formacao('1180729')).resolves.toMatchObject({ mandante: { formacao: '3-3-1-3' } });
    expect(client.fixture).toHaveBeenCalledTimes(1); expect(client.fixture).toHaveBeenCalledWith(1180729);
    expect(client.lineups).toHaveBeenCalledTimes(1); expect(client.lineups).toHaveBeenCalledWith(1180729);
    expect(client.events).not.toHaveBeenCalled(); expect(client.statistics).not.toHaveBeenCalled();
  });
  it('fixture inexistente é 404 sem consulta de lineup', async () => {
    client.fixture.mockRejectedValueOnce(new NotFoundException('Partida não encontrada'));
    await expect(controller.formacao('1')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.lineups).not.toHaveBeenCalled();
  });
  it('fixture existente sem lineup mantém o contrato de ausência', async () => {
    client.lineups.mockResolvedValueOnce([]);
    await expect(controller.formacao('1180729')).resolves.toMatchObject({ mandante: { formacao: null, titulares: [], reservas: [] } });
  });
  it('payload essencial inválido do client é 502', async () => {
    client.lineups.mockResolvedValueOnce([null]);
    await expect(controller.formacao('1180729')).rejects.toBeInstanceOf(BadGatewayException);
  });
  it('preserva erro externo controlado', async () => {
    client.lineups.mockRejectedValueOnce(new ServiceUnavailableException('Limite do serviço de partidas atingido'));
    await expect(controller.formacao('1180729')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
