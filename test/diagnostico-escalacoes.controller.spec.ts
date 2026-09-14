import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { DiagnosticoEscalacoesController } from '../src/ligas-competicoes/diagnostico-escalacoes.controller';
import { DiagnosticoEscalacoesService } from '../src/ligas-competicoes/diagnostico-escalacoes.service';

describe('GET /competicoes/:id/diagnostico-escalacoes', () => {
  let app: INestApplication;
  let base: string;
  const resultado = { competicaoId: 7, rodada: 27, quantidadeInscricoesAtivas: 2,
    quantidadeEscalacoesEncontradas: 1, quantidadeEscalacoesPendentes: 1,
    pendencias: [{ inscricaoId: 11, timeIdCartola: 202, nomeTime: 'Verde' }] };
  const service = { diagnosticar: jest.fn(async () => resultado) };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DiagnosticoEscalacoesController], providers: [
      JwtAuthGuard, AdminGuard,
      { provide: AuthService, useValue: { authenticateJwt: jest.fn(async (token: string) => ({ tipoUsuario: token, status: 'ATIVO' })) } },
      { provide: DiagnosticoEscalacoesService, useValue: service },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => app?.close());
  beforeEach(() => service.diagnosticar.mockClear());

  it('exige JWT e privilegio de administrador', async () => {
    expect((await fetch(`${base}/competicoes/7/diagnostico-escalacoes`)).status).toBe(401);
    expect((await fetch(`${base}/competicoes/7/diagnostico-escalacoes`, { headers: { Authorization: 'Bearer PLAYER' } })).status).toBe(403);
    expect(service.diagnosticar).not.toHaveBeenCalled();
  });

  it('retorna apenas contagens e pendencias para administrador', async () => {
    const response = await fetch(`${base}/competicoes/7/diagnostico-escalacoes`, { headers: { Authorization: 'Bearer PLATFORM_ADMIN' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resultado);
    expect(service.diagnosticar).toHaveBeenCalledWith(7);
  });

  it('valida o identificador', async () => {
    expect((await fetch(`${base}/competicoes/invalido/diagnostico-escalacoes`, { headers: { Authorization: 'Bearer PLATFORM_ADMIN' } })).status).toBe(400);
    expect(service.diagnosticar).not.toHaveBeenCalled();
  });
});
