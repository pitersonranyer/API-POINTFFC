import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { AdminLigasController } from '../src/admin/admin-ligas.controller';
import { AdminLigasService } from '../src/admin/admin-ligas.service';
import { AdminPremiacoesController } from '../src/admin/admin-premiacoes.controller';
import { AdminPremiacoesService } from '../src/admin/admin-premiacoes.service';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';

describe('acesso aos endpoints Admin', () => {
  let app: INestApplication;
  let base: string;
  const ligas = { listar: jest.fn(async () => [{ id: 1 }]), listarModalidades: jest.fn(async () => []) };
  const premiacoes = { listar: jest.fn(async () => []), substituir: jest.fn(async () => []) };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminLigasController, AdminPremiacoesController], providers: [
      JwtAuthGuard, AdminGuard,
      { provide: AuthService, useValue: { authenticateJwt: jest.fn(async (token: string) => {
        const [tipoUsuario, status = 'ATIVO'] = token.split(':');
        return { tipoUsuario, status };
      }) } },
      { provide: AdminLigasService, useValue: ligas },
      { provide: AdminPremiacoesService, useValue: premiacoes },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => app?.close());

  it('exige autenticacao e PLATFORM_ADMIN ativo', async () => {
    expect((await fetch(`${base}/admin/ligas`)).status).toBe(401);
    expect((await fetch(`${base}/admin/ligas`, { headers: { Authorization: 'Bearer PLAYER' } })).status).toBe(403);
    expect((await fetch(`${base}/admin/ligas`, { headers: { Authorization: 'Bearer PLATFORM_ADMIN:INATIVO' } })).status).toBe(403);
    expect((await fetch(`${base}/admin/ligas`, { headers: { Authorization: 'Bearer PLATFORM_ADMIN' } })).status).toBe(200);
    expect((await fetch(`${base}/admin/competicoes/7/premiacoes`, { headers: { Authorization: 'Bearer PLAYER' } })).status).toBe(403);
    expect((await fetch(`${base}/admin/competicoes/7/premiacoes`, { headers: { Authorization: 'Bearer PLATFORM_ADMIN:INATIVO' } })).status).toBe(403);
    expect((await fetch(`${base}/admin/competicoes/7/premiacoes`, { headers: { Authorization: 'Bearer PLATFORM_ADMIN' } })).status).toBe(200);
  });
});
