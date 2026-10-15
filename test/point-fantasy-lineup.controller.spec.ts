import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { LineupController } from '../src/point-fantasy/lineups/lineup.controller';
import { LineupService } from '../src/point-fantasy/lineups/lineup.service';

describe('Lineup HTTP contract and JWT identity', () => {
  let app: INestApplication;
  let base: string;
  const service = { create: jest.fn().mockResolvedValue({ id: 1 }), list: jest.fn().mockResolvedValue({ items: [] }),
    get: jest.fn().mockResolvedValue({ id: 1 }), update: jest.fn().mockResolvedValue({ id: 1 }),
    duplicate: jest.fn().mockResolvedValue({ id: 2 }), remove: jest.fn().mockResolvedValue({ excluida: true }) };
  beforeAll(async () => {
    const m = await Test.createTestingModule({ controllers: [LineupController], providers: [JwtAuthGuard,
      { provide: LineupService, useValue: service }, { provide: AuthService, useValue: { authenticateJwt: async (token: string) => {
        if (token === 'invalid') throw new UnauthorizedException();
        return { idUsuario: token === 'other' ? 22 : 11, status: token === 'blocked' ? 'BLOQUEADO' : 'ATIVO' };
      } } },
    ] }).compile();
    app = m.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => jest.clearAllMocks());
  const request = (route: string, method: string, body?: unknown, token = 'valid') => fetch(base + '/point-fantasy/' + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  it.each([
    ['POST','competicoes/1/escalacoes'],['GET','competicoes/1/escalacoes/minhas'],['GET','escalacoes/1'],
    ['PATCH','escalacoes/1'],['POST','escalacoes/1/duplicar'],['DELETE','escalacoes/1?versao=1'],
  ])('JWT obrigatorio %s %s', async (method, route) => {
    expect((await request(route, method, undefined, '')).status).toBe(401);
  });
  it.each(['invalid', 'blocked'])('rejeita token %s', async token => {
    expect((await request('escalacoes/1', 'GET', undefined, token)).status).toBe(token === 'blocked' ? 403 : 401);
  });
  it('identidade vem do JWT e nao do cliente', async () => {
    expect((await request('competicoes/1/escalacoes', 'POST', { formacao: '4-3-3' }, 'other')).status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(22, 1, expect.objectContaining({ formacao: '4-3-3' }));
    expect((await request('competicoes/1/escalacoes', 'POST', { formacao: '4-3-3', usuarioId: 99 })).status).toBe(400);
  });
  it.each([
    { formacao: 'invalida' }, { formacao: '4-3-3', titulares: null }, { formacao: '4-3-3', titulares: [1,1] },
    { formacao: '4-3-3', titulares: ['1'] }, { formacao: '4-3-3', reservas: [1,2,3,4,5,6] },
    { formacao: '4-3-3', titulares: Array.from({length:12},(_,i)=>i+1) },
  ])('rejeita DTO invalido %j', async body => {
    expect((await request('competicoes/1/escalacoes', 'POST', body)).status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });
  it('PATCH permite limpar campos opcionais mas exige versao', async () => {
    expect((await request('escalacoes/1', 'PATCH', { versao: 1, tecnico: null, capitaoAtletaId: null, reservaMagoAtletaId: null })).status).toBe(200);
    expect((await request('escalacoes/1', 'PATCH', { reservas: [] })).status).toBe(400);
    expect((await request('escalacoes/1', 'PATCH', { versao: 1, formacao: null })).status).toBe(400);
  });
  it('duplicacao e exclusao exigem versao e passam dono validado', async () => {
    expect((await request('escalacoes/1/duplicar', 'POST', { versao: 1 })).status).toBe(201);
    expect(service.duplicate).toHaveBeenCalledWith(11,1,1);
    expect((await request('escalacoes/1?versao=1', 'DELETE')).status).toBe(200);
    expect(service.remove).toHaveBeenCalledWith(11,1,1);
    expect((await request('escalacoes/1', 'DELETE')).status).toBe(400);
  });
  it('pagina limitada e ID unsigned', async () => {
    expect((await request('competicoes/1/escalacoes/minhas?page=1&limit=100', 'GET')).status).toBe(200);
    expect((await request('competicoes/1/escalacoes/minhas?limit=101', 'GET')).status).toBe(400);
    expect((await request('escalacoes/4294967296', 'GET')).status).toBe(400);
    expect((await request('escalacoes/0', 'GET')).status).toBe(400);
  });
});
