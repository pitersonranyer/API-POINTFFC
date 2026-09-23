import 'reflect-metadata';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AdminGuard } from '../src/auth/admin.guard';
import { AdminDashboardFinanceiroController } from '../src/admin/admin-dashboard-financeiro.controller';
import { AdminDashboardFinanceiroService } from '../src/admin/admin-dashboard-financeiro.service';

describe('GET /admin/dashboard-financeiro', () => {
  let app: INestApplication;
  let base: string;
  const auth = { authenticateJwt: jest.fn() };
  const dashboard = { consultar: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminDashboardFinanceiroController], providers: [
      JwtAuthGuard, AdminGuard, { provide: AuthService, useValue: auth },
      { provide: AdminDashboardFinanceiroService, useValue: dashboard },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/admin/dashboard-financeiro`;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 1, tipoUsuario: 'PLATFORM_ADMIN', status: 'ATIVO' });
    dashboard.consultar.mockResolvedValue({ natureza: 'PREVISTO_NOMINAL', itens: [] });
  });
  afterAll(() => app.close());
  const consultar = (query = '') => fetch(base + query, { headers: { Authorization: 'Bearer valid' } });

  it('exige JWT', async () => {
    expect((await fetch(base)).status).toBe(401);
    expect(dashboard.consultar).not.toHaveBeenCalled();
  });
  it('rejeita JWT invalido', async () => {
    auth.authenticateJwt.mockRejectedValueOnce(new UnauthorizedException());
    expect((await consultar()).status).toBe(401);
    expect(dashboard.consultar).not.toHaveBeenCalled();
  });
  it.each([
    ['PLAYER', 'ATIVO'], ['ORGANIZER', 'ATIVO'], ['PLATFORM_ADMIN', 'INATIVO'], ['PLATFORM_ADMIN', 'BLOQUEADO'],
  ])('bloqueia %s %s usando guards reais', async (tipoUsuario, status) => {
    auth.authenticateJwt.mockResolvedValueOnce({ idUsuario: 1, tipoUsuario, status });
    expect((await consultar()).status).toBe(403);
    expect(dashboard.consultar).not.toHaveBeenCalled();
  });
  it('aceita admin ativo e transforma filtros', async () => {
    expect((await consultar('?ligaId=1&competicaoId=7&rodada=27&pagina=2&limite=10')).status).toBe(200);
    expect(dashboard.consultar).toHaveBeenCalledWith({ ligaId: 1, competicaoId: 7, rodada: 27, pagina: 2, limite: 10 });
  });
  it('aplica paginacao padrao', async () => {
    expect((await consultar()).status).toBe(200);
    expect(dashboard.consultar).toHaveBeenCalledWith({ pagina: 1, limite: 20 });
  });
  it.each(['ligaId=0', 'competicaoId=abc', 'rodada=256', 'rodada=1.5', 'pagina=0', 'limite=101',
    'pagina=9007199254740992', 'ligaId=4294967296', 'ligaId=1&ligaId=2', 'desconhecido=1'])
  ('rejeita query invalida %s', async query => {
    expect((await consultar(`?${query}`)).status).toBe(400);
    expect(dashboard.consultar).not.toHaveBeenCalled();
  });
});
