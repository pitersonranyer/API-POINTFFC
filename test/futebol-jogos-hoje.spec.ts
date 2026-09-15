import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { get } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FutebolQueryModule } from '../src/futebol/futebol-query.module';
import { FutebolQueryService } from '../src/futebol/futebol-query.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { FootballDataClient } from '../src/futebol/football-data.client';
import { FutebolSyncService } from '../src/futebol/futebol-sync.service';
import { futebolDayInterval } from '../src/futebol/futebol-day';

const competition = (id = 1, codigo = 'BSA', ativa = true) => ({ id, codigo, ativa,
  nome: codigo === 'BSA' ? 'Campeonato Brasileiro Série A' : 'Competição ' + codigo,
  emblemaUrl: 'https://crests.example/' + codigo + '.png' });
const game = (id: number, date = '2026-09-15T22:00:00Z', comp = competition(), status = 'TIMED') => ({
  id, externalId: 10000 + id, competicaoId: comp.id, competicao: comp, temporada: 2026, rodada: 28,
  fase: 'REGULAR_SEASON', grupo: null, dataHoraUtc: new Date(date), status, vencedor: null,
  placarMandante: null, placarVisitante: null, placarIntervaloMandante: null, placarIntervaloVisitante: null,
  timeMandante: { id: 10, externalId: 1783, nome: 'Flamengo', nomeCurto: 'Flamengo', sigla: 'FLA',
    escudoUrl: 'https://crests.example/1783.svg', cartolaClubeId: 262 },
  timeVisitante: { id: 11, externalId: 1765, nome: 'Fluminense', nomeCurto: 'Fluminense', sigla: 'FLU',
    escudoUrl: 'https://crests.example/1765.svg', cartolaClubeId: 266 },
});

describe('GET público /futebol/jogos/hoje', () => {
  let app: INestApplication;
  let base: string;
  let games: any[];
  let clock: jest.SpyInstance;
  const externalSpies: jest.SpyInstance[] = [];
  const prisma = { futebolPartida: { findMany: jest.fn() } };
  function select(row: any, fields: any): any {
    return Object.fromEntries(Object.entries(fields).map(([key, value]: [string, any]) =>
      [key, value === true ? row[key] : select(row[key], value.select)]));
  }
  async function request() {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      get(base + '/futebol/jogos/hoje', response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
      }).on('error', reject);
    });
  }
  beforeAll(async () => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-15T12:00:00Z'));
    externalSpies.push(jest.spyOn(global, 'fetch').mockRejectedValue(new Error('HTTP externo proibido')));
    for (const method of ['getCompetition', 'getTeams', 'getMatches'] as const) {
      externalSpies.push(jest.spyOn(FootballDataClient.prototype, method).mockRejectedValue(new Error('Provider proibido')));
    }
    externalSpies.push(jest.spyOn(FutebolSyncService.prototype, 'syncCompeticao').mockRejectedValue(new Error('Sync proibido')));
    const module = await Test.createTestingModule({ imports: [FutebolQueryModule] }).overrideProvider(PrismaService).useValue(prisma).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    clock.mockReturnValue(Date.parse('2026-09-15T12:00:00Z'));
    games = [game(1)];
    prisma.futebolPartida.findMany.mockImplementation(async ({ where, orderBy, select: fields }) => {
      return games.filter(row =>
        (where.dataHoraUtc?.gte === undefined || row.dataHoraUtc >= where.dataHoraUtc.gte) &&
        (where.dataHoraUtc?.lt === undefined || row.dataHoraUtc < where.dataHoraUtc.lt) &&
        (where.competicao?.ativa === undefined || row.competicao.ativa === where.competicao.ativa)
      ).sort((a, b) => {
        for (const order of orderBy) for (const [key, direction] of Object.entries(order)) {
          if (a[key] < b[key]) return direction === 'asc' ? -1 : 1;
          if (a[key] > b[key]) return direction === 'asc' ? 1 : -1;
        }
        return 0;
      }).map(row => select(row, fields));
    });
  });
  afterEach(() => { externalSpies.forEach(spy => expect(spy).not.toHaveBeenCalled()); });
  afterAll(async () => { await app?.close(); jest.restoreAllMocks(); });

  it('retorna HTTP 200 sem autenticação e o contrato completo reutilizado de partida', async () => {
    const expected = JSON.parse(readFileSync(join(__dirname, 'fixtures/futebol-jogos-hoje.response.json'), 'utf8'));
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expected);
  });
  it('inclui início exato e último milissegundo, exclui instante anterior e início do dia seguinte', async () => {
    games = [game(1, '2026-09-15T02:59:59.999Z'), game(2, '2026-09-15T03:00:00.000Z'),
      game(3, '2026-09-16T02:59:59.999Z'), game(4, '2026-09-16T03:00:00.000Z')];
    const { body } = await request();
    expect(body).toMatchObject({ data: '2026-09-15', timezone: 'America/Sao_Paulo', total: 2 });
    expect(body.jogos.map((row: any) => row.id)).toEqual([2, 3]);
  });
  it('usa o dia de São Paulo quando UTC já está no dia seguinte', async () => {
    clock.mockReturnValue(Date.parse('2026-09-16T02:59:59.999Z'));
    expect((await request()).body.data).toBe('2026-09-15');
  });
  it('inclui competições ativas cadastradas, sem lista fixa ou filtro de temporada', async () => {
    games = [game(1), game(2, undefined, competition(2, 'CL')), game(3, undefined, competition(3, 'PL')),
      { ...game(4, undefined, competition(4, 'NOVA')), temporada: 2025 }, game(5, undefined, competition(5, 'PD', false))];
    const { body } = await request();
    expect(body.total).toBe(4);
    expect(body.jogos.map((row: any) => row.competicao.codigo)).toEqual(['BSA', 'CL', 'PL', 'NOVA']);
    expect(body.jogos[3].temporada).toBe(2025);
  });
  it('ordena por data, ID da competição e ID da partida para desempate estável', async () => {
    games = [game(5, '2026-09-15T23:00:00Z'), game(4, undefined, competition(2, 'CL')), game(3), game(2),
      game(1, '2026-09-15T04:00:00Z', competition(9, 'ELC'))];
    expect((await request()).body.jogos.map((row: any) => row.id)).toEqual([1, 2, 3, 4, 5]);
  });
  it('preserva todos os statuses, inclusive desconhecidos, fases nulas e placar zero', async () => {
    const statuses = ['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'AWARDED', 'POSTPONED', 'SUSPENDED', 'CANCELLED', 'PROVIDER_NEW'];
    games = statuses.map((status, index) => game(index + 1, undefined, undefined, status));
    Object.assign(games[0], { rodada: null, fase: null, placarMandante: 0, placarVisitante: 0 });
    const { body } = await request();
    expect(body.total).toBe(statuses.length);
    expect(body.jogos.map((row: any) => row.status)).toEqual(statuses);
    expect(body.jogos[0]).toMatchObject({ rodada: null, fase: null, placar: { mandante: 0, visitante: 0 } });
  });
  it('dia sem partidas retorna 200, total zero e lista vazia', async () => {
    games = [];
    expect(await request()).toEqual({ status: 200, body: { data: '2026-09-15', timezone: 'America/Sao_Paulo', total: 0, jogos: [] } });
  });
  it('retorna aliases persistidos e mantém Cartola somente nos jogos BSA', async () => {
    const international = game(2, undefined, competition(2, 'CL'));
    international.timeMandante = { ...international.timeMandante, externalId: 108, nome: 'Inter de Milão', nomeCurto: 'Inter' };
    international.timeVisitante = { ...international.timeVisitante, externalId: 524, nome: 'Paris Saint-Germain', nomeCurto: 'PSG' };
    games.push(international);
    const { body } = await request();
    expect(body.jogos[0].mandante).toMatchObject({ nome: 'Flamengo', cartolaClubeId: 262 });
    expect(body.jogos[0].visitante).toMatchObject({ nome: 'Fluminense', cartolaClubeId: 266 });
    expect(body.jogos[1].mandante).toMatchObject({ nome: 'Inter de Milão', nomeCurto: 'Inter', cartolaClubeId: null });
    expect(body.jogos[1].visitante).toMatchObject({ nome: 'Paris Saint-Germain', nomeCurto: 'PSG', cartolaClubeId: null });
  });
  it('faz uma chamada Prisma com intervalo semiaberto e select relacional, sem provider nem SQL de transformação', async () => {
    await request();
    expect(prisma.futebolPartida.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.futebolPartida.findMany).toHaveBeenCalledWith({
      where: { dataHoraUtc: { gte: new Date('2026-09-15T03:00:00Z'), lt: new Date('2026-09-16T03:00:00Z') }, competicao: { ativa: true } },
      orderBy: [{ dataHoraUtc: 'asc' }, { competicaoId: 'asc' }, { id: 'asc' }],
      select: expect.objectContaining({ competicao: { select: { id: true, codigo: true, nome: true, emblemaUrl: true } },
        timeMandante: expect.any(Object), timeVisitante: expect.any(Object) }),
    });
    expect(() => app.get(FootballDataClient)).toThrow();
    expect(() => app.get(FutebolSyncService)).toThrow();
  });
  it('captura o relógio uma vez, mesmo quando a consulta atravessa a virada do dia', async () => {
    clock.mockReturnValueOnce(Date.parse('2026-09-16T02:59:59.999Z')).mockReturnValue(Date.parse('2026-09-16T03:00:00Z'));
    const result = await app.get(FutebolQueryService).listarJogosHoje();
    expect(clock).toHaveBeenCalledTimes(1);
    expect(result.data).toBe('2026-09-15');
    expect(prisma.futebolPartida.findMany.mock.calls[0][0].where.dataHoraUtc.lt).toEqual(new Date('2026-09-16T03:00:00Z'));
  });
});

describe('Intervalo do dia em America/Sao_Paulo', () => {
  it.each([
    ['2026-09-15T12:00:00Z', '2026-09-15', '2026-09-15T03:00:00Z', '2026-09-16T03:00:00Z'],
    ['2026-09-16T02:59:59.999Z', '2026-09-15', '2026-09-15T03:00:00Z', '2026-09-16T03:00:00Z'],
    ['2027-01-01T02:00:00Z', '2026-12-31', '2026-12-31T03:00:00Z', '2027-01-01T03:00:00Z'],
    ['2024-02-29T12:00:00Z', '2024-02-29', '2024-02-29T03:00:00Z', '2024-03-01T03:00:00Z'],
    ['2018-11-04T12:00:00Z', '2018-11-04', '2018-11-04T03:00:00Z', '2018-11-05T02:00:00Z'],
    ['2019-02-16T12:00:00Z', '2019-02-16', '2019-02-16T02:00:00Z', '2019-02-17T03:00:00Z'],
  ])('%s resolve os dois limites independentemente, inclusive dias históricos de 23/25 horas', (instant, data, start, end) => {
    expect(futebolDayInterval(new Date(instant))).toEqual({ data, timezone: 'America/Sao_Paulo', inicioUtc: new Date(start), fimUtc: new Date(end) });
  });
});
