import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { get } from 'node:http';
import { FutebolQueryModule } from '../src/futebol/futebol-query.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { FootballDataClient } from '../src/futebol/football-data.client';

const team = (id: number) => ({ id, externalId: 1000 + id, cartolaClubeId: id === 1 ? 262 : 264, nome: 'Clube ' + id, nomeCurto: 'C' + id, sigla: 'C' + id, escudoUrl: 'https://crests.example/' + id + '.svg' });
const game = (id: number, rodada: number | null, status = 'TIMED', date = '2026-09-12T19:00:00Z') => ({
  id, externalId: 10000 + id, competicaoId: 1, temporada: 2026, rodada, fase: 'REGULAR_SEASON', grupo: null,
  dataHoraUtc: new Date(date), status, vencedor: null, placarMandante: null, placarVisitante: null,
  placarIntervaloMandante: null, placarIntervaloVisitante: null, timeMandante: team(1), timeVisitante: team(2),
});
describe('Futebol API pública de leitura', () => {
  let app: INestApplication;
  let base: string;
  let games: any[];
  let competitions: any[];
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      return (value.in === undefined || value.in.includes(row[key]))
        && (value.not === undefined || row[key] !== value.not)
        && (value.gte === undefined || row[key] >= value.gte)
        && (value.lte === undefined || row[key] <= value.lte);
    }
    return row[key] === value;
  });
  function select(row: any, fields: any): any {
    if (!row) return null;
    return Object.fromEntries(Object.entries(fields).map(([key, value]: [string, any]) => [key, value === true ? row[key] : select(row[key], value.select)]));
  }
  function query(rows: any[], args: any) {
    return rows.filter(row => matches(row, args.where)).sort((a, b) => {
      for (const order of Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy ?? {}]) {
        for (const [field, direction] of Object.entries(order)) {
          if (a[field] < b[field]) return direction === 'asc' ? -1 : 1;
          if (a[field] > b[field]) return direction === 'asc' ? 1 : -1;
        }
      }
      return 0;
    }).map(row => select(row, args.select));
  }
  const prisma = {
    futebolCompeticao: { findMany: jest.fn(async args => query(competitions, args)), findUnique: jest.fn(async args => select(competitions.find(row => row.codigo === args.where.codigo), args.select)) },
    futebolPartida: { findMany: jest.fn(async args => query(games, args)), findFirst: jest.fn(async args => query(games, args)[0] ?? null) },
  };
  const externalSpies: jest.SpyInstance[] = [];
  async function request(path: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      get(base + path, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
      }).on('error', reject);
    });
  }
  beforeAll(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-11T12:00:00Z'));
    externalSpies.push(jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External HTTP forbidden')));
    for (const method of ['getCompetition', 'getTeams', 'getMatches'] as const) externalSpies.push(jest.spyOn(FootballDataClient.prototype, method).mockRejectedValue(new Error('External provider forbidden')));
    const module = await Test.createTestingModule({ imports: [FutebolQueryModule] }).overrideProvider(PrismaService).useValue(prisma).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    competitions = [{ id: 1, codigo: 'BSA', nome: 'Brasileirão', pais: 'Brazil', emblemaUrl: null, temporadaAtual: 2026, ativa: true },
      { id: 2, codigo: 'ZZZ', nome: 'Inativa', ativa: false }, { id: 3, codigo: 'AAA', nome: 'Local', ativa: true }];
    games = [game(3, 25), game(2, 24), game(1, 24, 'FINISHED', '2026-09-11T19:00:00Z')];
  });
  afterEach(() => { for (const spy of externalSpies) expect(spy).not.toHaveBeenCalled(); });
  afterAll(async () => { await app?.close(); jest.restoreAllMocks(); });

  it('lista apenas competições ativas em ordem estável e sem autenticação', async () => {
    const response = await request('/futebol/competicoes');
    expect(response.status).toBe(200); expect(response.body.map((row: any) => row.codigo)).toEqual(['AAA', 'BSA']);
    expect(response.body[1]).toEqual({ codigo: 'BSA', nome: 'Brasileirão', pais: 'Brazil', emblemaUrl: null, temporadaAtual: 2026 });
  });
  it.each(['/XXX/jogos', '/XXX/rodadas/1', '/XXX/rodada-atual'])('retorna 404 para competição inexistente: %s', async path => {
    expect((await request('/futebol/competicoes' + path)).status).toBe(404);
  });
  it('lista somente jogos da competição e temporada atual', async () => {
    games.push({ ...game(4, 24), competicaoId: 2 }, { ...game(5, 24), temporada: 2025 });
    const { body, status } = await request('/futebol/competicoes/BSA/jogos');
    expect(status).toBe(200); expect(body.total).toBe(3); expect(body.temporada).toBe(2026);
    expect(body.competicao).toEqual({ codigo: 'BSA', nome: 'Brasileirão' });
  });
  it('filtra temporada', async () => {
    games.push({ ...game(4, 24), temporada: 2025 });
    expect((await request('/futebol/competicoes/BSA/jogos?temporada=2025')).body.jogos.map((row: any) => row.id)).toEqual([4]);
  });
  it('filtra rodada', async () => expect((await request('/futebol/competicoes/BSA/jogos?rodada=25')).body.total).toBe(1));
  it('filtra status', async () => expect((await request('/futebol/competicoes/BSA/jogos?status=FINISHED')).body.jogos[0].id).toBe(1));
  it('filtra intervalo de dias UTC incluindo o dia final inteiro', async () => {
    games.push(game(4, 25, 'TIMED', '2026-09-12T23:59:59.999Z'), game(5, 25, 'TIMED', '2026-09-13T00:00:00Z'));
    expect((await request('/futebol/competicoes/BSA/jogos?dataInicio=2026-09-12&dataFim=2026-09-12')).body.jogos.map((row: any) => row.id)).toEqual([2, 3, 4]);
  });
  it('filtra instante ISO com fuso explícito', async () => {
    expect((await request('/futebol/competicoes/BSA/jogos?dataInicio=2026-09-12T19:00:00Z&dataFim=2026-09-12T16:00:00-03:00')).body.total).toBe(2);
  });
  it.each(['temporada=0', 'temporada=2.5', 'temporada=abc', 'temporada=65536', 'temporada=', 'temporada=1e3', 'rodada=-1', 'rodada=1.5',
    'status=INVALID', 'status=', 'dataInicio=2026-02-30', 'dataFim=abc', 'dataInicio=2026-09-12T19:00:00',
    'dataInicio=2026-09-13&dataFim=2026-09-12', 'temporada=2026&temporada=2025', 'extra=1'])('retorna HTTP 400 para %s', async filter => {
    expect((await request('/futebol/competicoes/BSA/jogos?' + filter)).status).toBe(400);
    expect(prisma.futebolPartida.findMany).not.toHaveBeenCalled();
  });
  it.each(['/bsa/jogos', '/BSA!/jogos', '/ABCDEFGHIJK/jogos', '/BSA/rodadas/0', '/BSA/rodadas/2.5', '/BSA/rodadas/abc'])('valida parâmetros: %s', async path => {
    expect((await request('/futebol/competicoes' + path)).status).toBe(400);
  });
  it('retorna rodada específica e temporada atual', async () => {
    const { body } = await request('/futebol/competicoes/BSA/rodadas/24');
    expect(body).toMatchObject({ rodada: 24, temporada: 2026, total: 2 });
  });
  it('retorna rodada vazia com HTTP 200', async () => {
    const { body, status } = await request('/futebol/competicoes/BSA/rodadas/99');
    expect(status).toBe(200); expect(body).toMatchObject({ rodada: 99, total: 0, jogos: [] });
  });
  it.each(['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED'])('seleciona rodada elegível com %s sem ficar presa em POSTPONED antigo', async status => {
    games = [game(1, 25, 'TIMED', '2026-12-31T00:00:00Z'), game(2, 24, status), game(3, 21, 'POSTPONED'), game(4, 1, 'CANCELLED'), { ...game(5, 1), temporada: 2025 }];
    const { body } = await request('/futebol/competicoes/BSA/rodada-atual');
    expect(body).toMatchObject({ rodada: 24, total: 1 }); expect(body.jogos[0].id).toBe(2);
  });
  it.each(['POSTPONED', 'SUSPENDED'])('não seleciona rodada definida apenas por %s', async status => {
    games = [game(1, 21, status)];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body).toMatchObject({ rodada: null, total: 0, jogos: [] });
  });
  it('prioriza IN_PLAY sobre agendamento mais próximo', async () => {
    games = [game(1, 25, 'TIMED', '2026-09-11T12:00:00Z'), game(2, 24, 'IN_PLAY', '2026-09-11T11:00:00Z')];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body.rodada).toBe(24);
  });
  it('usa proximidade futura em vez do número da rodada', async () => {
    games = [game(1, 21, 'TIMED', '2026-12-31T00:00:00Z'), game(2, 24)];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body.rodada).toBe(24);
  });
  it('mantém POSTPONED na própria rodada atual e na consulta específica antiga', async () => {
    games = [game(1, 24), game(2, 24, 'POSTPONED'), game(3, 21, 'POSTPONED')];
    const { body } = await request('/futebol/competicoes/BSA/rodada-atual');
    expect(body).toMatchObject({ rodada: 24, total: 2 });
    expect(body.jogos[1].status).toBe('POSTPONED');
    expect((await request('/futebol/competicoes/BSA/rodadas/21')).body.jogos[0].status).toBe('POSTPONED');
  });
  it('seleciona próxima rodada futura após rodada encerrada', async () => {
    games = [game(1, 23, 'FINISHED'), game(2, 24)];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body.rodada).toBe(24);
  });
  it('ignora agendamento passado sem status atualizado e usa última rodada encerrada', async () => {
    games = [game(1, 21, 'TIMED', '2026-07-29T00:00:00Z'), game(2, 23, 'FINISHED')];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body.rodada).toBe(23);
  });
  it('seleciona maior rodada encerrada ao término da temporada', async () => {
    games = [game(1, 37, 'FINISHED'), game(2, 38, 'FINISHED')];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body.rodada).toBe(38);
  });
  it('ignora canceladas no fallback e considera AWARDED encerrado', async () => {
    games = [game(1, 37, 'AWARDED'), game(2, 38, 'CANCELLED')];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body.rodada).toBe(37);
  });
  it.each(['sem jogos', 'apenas canceladas', 'sem rodada'])('retorna rodada null quando %s', async scenario => {
    games = scenario === 'sem jogos' ? [] : [game(1, scenario === 'sem rodada' ? null : 1, scenario === 'apenas canceladas' ? 'CANCELLED' : 'TIMED')];
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body).toMatchObject({ rodada: null, total: 0, jogos: [] });
  });
  it('retorna todos os status da rodada selecionada', async () => {
    games.push(game(4, 24, 'CANCELLED'));
    expect((await request('/futebol/competicoes/BSA/rodada-atual')).body.total).toBe(3);
  });
  it('preserva null, zero, times e datas UTC; não expõe campos ORM', async () => {
    games[0].placarMandante = 0;
    const { body } = await request('/futebol/competicoes/BSA/jogos');
    expect(body.jogos[0]).toEqual({ id: 1, externalId: 10001, temporada: 2026, rodada: 24, fase: 'REGULAR_SEASON', grupo: null,
      dataHoraUtc: '2026-09-11T19:00:00.000Z', status: 'FINISHED', vencedor: null, mandante: team(1), visitante: team(2),
      placar: { mandante: null, visitante: null }, placarIntervalo: { mandante: null, visitante: null } });
    expect(body.jogos[2].placar.mandante).toBe(0);
  });
  it('ordena por data e desempata por ID usando consulta relacional única', async () => {
    const { body } = await request('/futebol/competicoes/BSA/jogos');
    expect(body.jogos.map((row: any) => row.id)).toEqual([1, 2, 3]);
    expect(prisma.futebolPartida.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.futebolPartida.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ dataHoraUtc: 'asc' }, { id: 'asc' }],
      select: expect.objectContaining({ timeMandante: expect.any(Object), timeVisitante: expect.any(Object) }) }));
  });
  it('os quatro endpoints não invocam FootballDataClient nem HTTP externo', async () => {
    for (const path of ['', '/BSA/jogos', '/BSA/rodadas/24', '/BSA/rodada-atual']) expect((await request('/futebol/competicoes' + path)).status).toBe(200);
    expect(() => app.get(FootballDataClient)).toThrow();
    for (const spy of externalSpies) expect(spy).not.toHaveBeenCalled();
  });
  it.each(['/BSA/jogos', '/BSA/rodadas/24', '/BSA/rodada-atual'])('retorna vínculos persistidos sem consultas adicionais em %s', async path => {
    const { body } = await request('/futebol/competicoes' + path);
    expect(body.jogos[0].mandante.cartolaClubeId).toBe(262);
    expect(body.jogos[0].visitante.cartolaClubeId).toBe(264);
    expect(prisma.futebolPartida.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.futebolPartida.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ timeMandante: { select: expect.objectContaining({ cartolaClubeId: true }) } }),
    }));
    expect(body.jogos[0]).not.toHaveProperty('atletas');
  });
  it('clube BSA desconhecido pode retornar vínculo null', async () => {
    games[2].timeMandante.cartolaClubeId = null;
    expect((await request('/futebol/competicoes/BSA/jogos')).body.jogos[0].mandante.cartolaClubeId).toBeNull();
  });
  it('não expõe vínculo Cartola fora de BSA mesmo para clube compartilhado', async () => {
    games = [{ ...game(1, 1), competicaoId: 3 }];
    const { status, body } = await request('/futebol/competicoes/AAA/jogos');
    expect(status).toBe(200);
    expect(body.jogos[0].mandante.cartolaClubeId).toBeNull();
    expect(body.jogos[0].visitante.cartolaClubeId).toBeNull();
  });
});
