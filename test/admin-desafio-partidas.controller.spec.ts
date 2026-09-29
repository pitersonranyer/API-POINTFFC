import { INestApplication, ServiceUnavailableException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminDesafiosController } from '../src/admin/admin-desafios.controller';
import { AdminDesafiosService } from '../src/admin/admin-desafios.service';
import { AdminDesafioPartidasService } from '../src/admin/admin-desafio-partidas.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthService } from '../src/auth/auth.service';

describe('Admin Desafio partidas HTTP', () => {
  let app: INestApplication;
  let base: string;
  const partidas = { pesquisar: jest.fn(), adicionar: jest.fn(), listar: jest.fn(), remover: jest.fn(), reordenar: jest.fn() };
  const desafios = { buscar: jest.fn() };
  const request = (method: string, path: string, body?: unknown, token: string | null = 'PLATFORM_ADMIN') => fetch(`${base}/admin/desafios${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminDesafiosController], providers: [JwtAuthGuard, AdminGuard,
      { provide: AdminDesafiosService, useValue: desafios }, { provide: AdminDesafioPartidasService, useValue: partidas },
      { provide: AuthService, useValue: { authenticateJwt: async (token: string) => {
        if (token === 'INVALIDO') throw new UnauthorizedException();
        const [tipoUsuario, status = 'ATIVO'] = token.split(':'); return { idUsuario: 42, tipoUsuario, status };
      } } },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    for (const fn of Object.values(partidas)) fn.mockResolvedValue([]);
  });

  it.each([
    ['GET', '/fixtures?date=2030-10-03', undefined, 200], ['POST', '/7/partidas', { fixtureId: 123 }, 201],
    ['GET', '/7/partidas', undefined, 200], ['DELETE', '/7/partidas/1', undefined, 200],
    ['PATCH', '/7/partidas/ordem', { partidaIds: [1, 2] }, 200],
  ])('exige JWT e PLATFORM_ADMIN ativo em %s %s', async (method, path, body, status) => {
    expect((await request(method as string, path as string, body, null)).status).toBe(401);
    expect((await request(method as string, path as string, body, 'INVALIDO')).status).toBe(401);
    for (const token of ['PLAYER', 'ORGANIZER', 'PLATFORM_ADMIN:INATIVO', 'PLATFORM_ADMIN:BLOQUEADO']) {
      expect((await request(method as string, path as string, body, token)).status).toBe(403);
    }
    for (const fn of Object.values(partidas)) expect(fn).not.toHaveBeenCalled();
    expect((await request(method as string, path as string, body)).status).toBe(status);
  });

  it('rota fixtures precede :id e converte filtros sem persistencia', async () => {
    expect((await request('GET', '/fixtures?date=2030-10-03&league=71&team=127&season=2030')).status).toBe(200);
    expect(partidas.pesquisar).toHaveBeenCalledWith({ date: '2030-10-03', league: 71, team: 127, season: 2030 });
    expect(desafios.buscar).not.toHaveBeenCalled();
    expect((await request('GET', '/fixtures?from=2030-10-01&to=2030-10-07&league=71&season=2030')).status).toBe(200);
  });

  it.each(['date=2030-02-30', 'date=ontem', 'league=0', 'team=-1', 'season=abc', 'league=4294967296', 'timezone=America/Sao_Paulo'])
  ('rejeita filtro invalido/nao suportado: %s', async query => {
    expect((await request('GET', `/fixtures?${query}`)).status).toBe(400);
    expect(partidas.pesquisar).not.toHaveBeenCalled();
  });

  it('preserva erro externo sem expor headers ou resposta bruta', async () => {
    partidas.pesquisar.mockRejectedValueOnce(new ServiceUnavailableException('football-data.org indisponivel para esta consulta.'));
    const result = await request('GET', '/fixtures?date=2030-10-03');
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ statusCode: 503, message: 'football-data.org indisponivel para esta consulta.' });
  });

  it('adiciona exclusivamente pelo fixtureId do body', async () => {
    expect((await request('POST', '/7/partidas', { fixtureId: 123 })).status).toBe(201);
    expect(partidas.adicionar).toHaveBeenCalledWith(7, 123);
  });

  it.each(['nomeMandante', 'mandanteNome', 'leagueId', 'nomeCompeticao', 'logoMandanteUrl', 'dataInicio', 'status', 'ordem', 'desafioId'])
  ('nao aceita snapshot/controle enviado no body: %s', async campo => {
    expect((await request('POST', '/7/partidas', { fixtureId: 123, [campo]: 'forjado' })).status).toBe(400);
    expect(partidas.adicionar).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.2, '123', null, 4294967296])('rejeita fixtureId invalido: %j', async fixtureId => {
    expect((await request('POST', '/7/partidas', { fixtureId })).status).toBe(400);
    expect(partidas.adicionar).not.toHaveBeenCalled();
  });

  it.each([{ partidaIds: [1, 1] }, { partidaIds: ['1'] }, { partidaIds: [0] }, { partidaIds: null }, {}])
  ('valida lista de reordenacao: %j', async body => {
    expect((await request('PATCH', '/7/partidas/ordem', body)).status).toBe(400);
    expect(partidas.reordenar).not.toHaveBeenCalled();
  });

  it('encaminha IDs internos e rejeita parametros invalidos', async () => {
    await request('GET', '/7/partidas'); expect(partidas.listar).toHaveBeenCalledWith(7);
    await request('DELETE', '/7/partidas/2'); expect(partidas.remover).toHaveBeenCalledWith(7, 2);
    await request('PATCH', '/7/partidas/ordem', { partidaIds: [2, 1] }); expect(partidas.reordenar).toHaveBeenCalledWith(7, [2, 1]);
    expect((await request('DELETE', '/7/partidas/abc')).status).toBe(400);
    expect((await request('GET', '/0/partidas')).status).toBe(400);
  });
});
