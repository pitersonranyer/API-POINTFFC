import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AdminGuard } from '../src/auth/admin.guard';
import { AdminPointFantasyController, PointFantasyController } from '../src/point-fantasy/point-fantasy.controller';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';

describe('POINT Fantasy HTTP authorization and validation', () => {
  let app: INestApplication;
  let url: string;
  const service = { closeCompetition: jest.fn().mockResolvedValue({ competicaoId: 1 }), capture: jest.fn().mockResolvedValue({ id: 1 }), freeze: jest.fn(), createCompetition: jest.fn(), publish: jest.fn(), catalogs: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminPointFantasyController, PointFantasyController], providers: [
      JwtAuthGuard, AdminGuard, { provide: PointFantasyService, useValue: service },
      { provide: AuthService, useValue: { authenticateJwt: async (token: string) => {
        if (token === 'invalid') throw new UnauthorizedException();
        return { idUsuario: 7, tipoUsuario: token === 'player' ? 'PLAYER' : 'PLATFORM_ADMIN', status: token === 'inactive' ? 'INATIVO' : 'ATIVO' };
      } } },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => jest.clearAllMocks());
  const routes = ['catalogos/capturar', 'catalogos/1/congelar', 'competicoes', 'competicoes/1/publicar', 'competicoes/1/fechar'];
  it.each(routes)('bloqueia anonimo em %s', async route => {
    expect((await fetch(`${url}/admin/point-fantasy/${route}`, { method: 'POST' })).status).toBe(401);
  });
  it.each(['player', 'inactive', 'invalid'])('bloqueia identidade %s em todas as mutacoes', async token => {
    for (const route of routes) {
      expect((await fetch(`${url}/admin/point-fantasy/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(token === 'invalid' ? 401 : 403);
    }
    expect(service.capture).not.toHaveBeenCalled();
    expect(service.createCompetition).not.toHaveBeenCalled();
  });
  it('admin ativo pode capturar com contrato valido', async () => {
    const res = await fetch(`${url}/admin/point-fantasy/catalogos/capturar`, { method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ temporada: 2030, rodada: 2, versao: 1 }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1 });
  });
  it('rejeita versao omitida e atributos extras', async () => {
    const res = await fetch(`${url}/admin/point-fantasy/catalogos/capturar`, { method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ temporada: 2030, rodada: 2, status: 'CONGELADO' }) });
    expect(res.status).toBe(400);
    expect(service.capture).not.toHaveBeenCalled();
  });
  it('consulta publica e paginacao limitada', async () => {
    expect((await fetch(`${url}/point-fantasy/catalogos`)).status).toBe(200);
    expect((await fetch(`${url}/point-fantasy/catalogos?limit=101`)).status).toBe(400);
  });
  const closeBody = { temporada: 2026, rodada: 31, revisao: '2', hashFonte: 'a'.repeat(64),
    operacaoId: 'af29da5e-e455-4d88-a266-4eef2adbd25a', motivo: 'Homologacao autorizada' };
  it('forwards admin identity and exact source reference for closure', async () => {
    const res = await fetch(`${url}/admin/point-fantasy/competicoes/1/fechar`, { method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(closeBody) });
    expect(res.status).toBe(201);
    expect(service.closeCompetition).toHaveBeenCalledWith(1, 7, closeBody);
  });
  it.each([{ ...closeBody, usuarioId: 99 }, { ...closeBody, revisao: '0' }, { ...closeBody, operacaoId: 'bad' },
    { ...closeBody, hashFonte: 'bad' }, { ...closeBody, rodada: 39 }])('rejects forged/invalid closure body', async body => {
    expect((await fetch(`${url}/admin/point-fantasy/competicoes/1/fechar`, { method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400);
    expect(service.closeCompetition).not.toHaveBeenCalled();
  });
});
