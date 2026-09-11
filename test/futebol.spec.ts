import { ConfigService } from '@nestjs/config';
import { FootballDataClient } from '../src/futebol/football-data.client';
import { mapCompetition, mapTeam, mapMatch } from '../src/futebol/football-data.normalizer';
import { FutebolSyncService } from '../src/futebol/futebol-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';

const competition = { id: 2013, code: 'BSA', name: 'Brasileirão', type: 'LEAGUE', emblem: null, area: { name: 'Brazil' }, currentSeason: { startDate: '2026-01-28' } };
const team = { id: 10, name: 'Clube A', shortName: 'A', tla: 'AAA', crest: 'https://crests.football-data.org/original.svg', area: { name: 'Brazil' } };
const fixture = () => ({ id: 100, competition: { id: 2013, code: 'BSA' }, season: { startDate: '2026-01-28' }, matchday: 1, stage: 'REGULAR_SEASON', group: null, homeTeam: { id: 10 }, awayTeam: { id: 20 }, utcDate: '2026-09-12T00:30:00Z', status: 'TIMED', lastUpdated: '2026-09-11T10:00:00Z', score: { winner: null as string | null, fullTime: { home: null as number | null, away: null as number | null }, halfTime: { home: null, away: null } } });

describe('football-data normalização', () => {
  it.each([
    [1766, 'CA Mineiro', 'Atlético-MG'],
    [1768, 'CA Paranaense', 'Athletico-PR'],
    [1783, 'CR Flamengo', 'Flamengo'],
    [1779, 'SC Corinthians Paulista', 'Corinthians'],
  ])('mapeia clube %s preservando nome original', (id, name, display) => {
    expect(mapTeam({ ...team, id, name })).toMatchObject({ nomeOriginal: name, nome: display, nomeCurto: display });
  });
  it('identifica clube pelo ID mesmo se o nome bruto mudar', () => {
    expect(mapTeam({ ...team, id: 1766, name: 'Novo nome institucional' })).toMatchObject({ nome: 'Atlético-MG', nomeOriginal: 'Novo nome institucional' });
  });
  it.each([null, 'Clube A curto'])('clube desconhecido preserva nome e aplica fallback seguro (%s)', shortName => {
    expect(mapTeam({ ...team, shortName })).toMatchObject({ nomeOriginal: 'Clube A', nome: 'Clube A', nomeCurto: shortName ?? 'Clube A' });
  });
  it('mapeia competição e temporada corrente', () => expect(mapCompetition(competition)).toMatchObject({ externalId: 2013, codigo: 'BSA', temporadaAtual: 2026 }));
  it('preserva URL original do escudo', () => expect(mapTeam(team).escudoUrl).toBe(team.crest));
  it('mapeia partida com UTC e placares nulos', () => {
    expect(mapMatch(fixture(), 2013, 2026)).toMatchObject({ rodada: 1, dataHoraUtc: new Date('2026-09-12T00:30:00Z'), placarMandante: null, placarVisitante: null, status: 'TIMED' });
  });
  it.each([
    { ...competition, code: 'PL' }, { ...competition, currentSeason: null }, { ...competition, id: '2013' },
  ])('rejeita competição inválida', value => expect(() => mapCompetition(value)).toThrow('resposta inválida'));
  it('rejeita temporada divergente', () => expect(() => mapMatch(fixture(), 2013, 2025)).toThrow('divergentes'));
  it('rejeita placar inválido sem convertê-lo para zero', () => {
    const value = fixture(); value.score.fullTime.home = -1;
    expect(() => mapMatch(value, 2013, 2026)).toThrow('resposta inválida');
  });
});

describe('FootballDataClient', () => {
  const original = global.fetch;
  const fetchMock = jest.fn();
  let client: FootballDataClient;
  beforeEach(() => {
    global.fetch = fetchMock; fetchMock.mockReset();
    client = new FootballDataClient({ get: () => 'secret-test-token' } as unknown as ConfigService);
  });
  afterEach(() => { global.fetch = original; jest.useRealTimers(); });
  it('não consulta API sem token', async () => {
    await expect(new FootballDataClient({ get: () => '' } as unknown as ConfigService).getCompetition()).rejects.toThrow('não configurado');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('envia header e restringe consulta à temporada', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await client.getMatches('BSA', 2026);
    expect(fetchMock).toHaveBeenCalledWith('https://api.football-data.org/v4/competitions/BSA/matches?season=2026', expect.objectContaining({ headers: { 'X-Auth-Token': 'secret-test-token' } }));
  });
  it.each([401, 403, 404, 429, 500, 503])('trata HTTP %s sem retry nem exposição de resposta', async status => {
    const json = jest.fn();
    fetchMock.mockResolvedValue({ ok: false, status, json });
    await expect(client.getCompetition()).rejects.toThrow(status >= 500 ? '5xx' : String(status));
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(json).not.toHaveBeenCalled();
  });
  it('trata JSON inválido', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('secret-test-token'); } });
    await expect(client.getCompetition()).rejects.toThrow('resposta inválida');
  });
  it('sanitiza falha de rede', async () => {
    fetchMock.mockRejectedValue(new Error('secret-test-token'));
    await expect(client.getCompetition()).rejects.toThrow('falha de conexão');
  });
  it('aborta por timeout', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')))));
    const result = expect(client.getCompetition()).rejects.toThrow('timeout');
    await jest.advanceTimersByTimeAsync(15000); await result;
  });
});

describe('FutebolSyncService com persistência em memória', () => {
  function setup() {
    const rows = () => {
      const data = new Map<number, any>();
      return { data, upsert: jest.fn(async ({ where, create, update }) => {
        const row = data.has(where.externalId) ? { ...data.get(where.externalId), ...update } : { id: data.size + 1, ...create };
        data.set(where.externalId, row); return row;
      }), findUnique: jest.fn(async ({ where }) => data.get(where.externalId)),
      count: jest.fn(async () => data.size), findMany: jest.fn(async () => [...data.values()].slice(0, 3)) };
    };
    const tx = { futebolCompeticao: rows(), futebolTime: rows(), futebolPartida: rows() };
    const prisma = { $transaction: jest.fn(async fn => fn(tx)) };
    const match = fixture();
    const client = { getCompetition: jest.fn(async () => competition),
      getTeams: jest.fn(async () => ({ competition, season: { startDate: '2026-01-28' }, teams: [team, { ...team, id: 20, name: 'Clube B' }] })),
      getMatches: jest.fn(async () => ({ competition, matches: [match] })) };
    return { tx, prisma, client, match, service: new FutebolSyncService(prisma as unknown as PrismaService, client as unknown as FootballDataClient) };
  }
  it('insere na primeira execução', async () => {
    const { service, tx } = setup(); await service.syncBrasileirao();
    expect(tx.futebolCompeticao.data.size).toBe(1); expect(tx.futebolTime.data.size).toBe(2); expect(tx.futebolPartida.data.size).toBe(1);
    expect(tx.futebolPartida.data.get(100)).toMatchObject({ competicaoId: 1, timeMandanteId: 1, timeVisitanteId: 2, placarMandante: null });
  });
  it('sincronização posterior mantém nome amigável e atualiza original sem duplicar clube', async () => {
    const { service, tx, client } = setup();
    const response = await client.getTeams();
    response.teams.push({ ...team, id: 1766, name: 'CA Mineiro' });
    client.getTeams.mockResolvedValue(response);
    await service.syncBrasileirao();
    expect(tx.futebolTime.data.get(1766)).toMatchObject({ nome: 'Atlético-MG', nomeOriginal: 'CA Mineiro' });
    response.teams[2].name = 'CA Mineiro atualizado';
    await service.syncBrasileirao();
    expect(tx.futebolTime.data.get(1766)).toMatchObject({ nome: 'Atlético-MG', nomeCurto: 'Atlético-MG', nomeOriginal: 'CA Mineiro atualizado' });
    expect(tx.futebolTime.data.size).toBe(3);
  });
  it('atualiza placar/status e não duplica na segunda execução', async () => {
    const { service, tx, match, client } = setup(); await service.syncBrasileirao();
    match.status = 'FINISHED'; match.score.fullTime = { home: 2, away: 0 }; match.score.winner = 'HOME_TEAM';
    match.lastUpdated = '2026-09-12T03:00:00Z';
    await service.syncBrasileirao();
    expect(tx.futebolCompeticao.data.size).toBe(1); expect(tx.futebolTime.data.size).toBe(2); expect(tx.futebolPartida.data.size).toBe(1);
    expect(tx.futebolPartida.data.get(100)).toMatchObject({ status: 'FINISHED', placarMandante: 2, placarVisitante: 0 });
    expect(client.getCompetition).toHaveBeenCalledTimes(2);
  });
  it('preserva partida ausente na consulta seguinte', async () => {
    const { service, tx, client } = setup(); await service.syncBrasileirao();
    client.getMatches.mockResolvedValue({ competition, matches: [] }); await service.syncBrasileirao();
    expect(tx.futebolPartida.data.size).toBe(1);
  });
  it('não sobrescreve partida com atualização mais antiga', async () => {
    const { service, tx, match } = setup(); await service.syncBrasileirao();
    match.lastUpdated = '2026-09-10T10:00:00Z'; match.status = 'SCHEDULED'; await service.syncBrasileirao();
    expect(tx.futebolPartida.data.get(100).status).toBe('TIMED');
  });
  it('valida todos os dados antes de escrever', async () => {
    const { service, prisma, match } = setup(); match.awayTeam.id = 999;
    await expect(service.syncBrasileirao()).rejects.toThrow('clube ausente');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('interrompe 429 sem gravar e permite nova execução manual', async () => {
    const { service, prisma, client } = setup(); client.getTeams.mockRejectedValueOnce(new Error('429'));
    await expect(service.syncBrasileirao()).rejects.toThrow('429'); expect(prisma.$transaction).not.toHaveBeenCalled();
    await service.syncBrasileirao(); expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('compartilha execução simultânea no mesmo processo', async () => {
    const { service, client } = setup(); await Promise.all([service.syncBrasileirao(), service.syncBrasileirao()]);
    expect(client.getCompetition).toHaveBeenCalledTimes(1); expect(client.getTeams).toHaveBeenCalledTimes(1); expect(client.getMatches).toHaveBeenCalledTimes(1);
  });
});
