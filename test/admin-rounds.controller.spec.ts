import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AdminRoundsController } from '../src/round-processing/admin-rounds.controller';
import { RoundProcessingService } from '../src/round-processing/round-processing.service';

describe('POST admin/rodadas/:rodada/reprocessar-parciais', () => {
  let app: INestApplication;
  let base: string;
  const summary = { temporada: 2026, rodada: 25, status: 'PARCIAL', timesProcessados: 3, timesComErro: 0, substituicoesAlteradas: 1, duracaoMs: 10, processadoEm: '2026-09-07T00:00:00.000Z' };
  const processing = { reprocessarParciais: jest.fn().mockResolvedValue(summary) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminRoundsController], providers: [
      JwtAuthGuard, AdminGuard,
      { provide: AuthService, useValue: { authenticateJwt: jest.fn(async (token: string) => ({ tipoUsuario: token, status: 'ATIVO' })) } },
      { provide: RoundProcessingService, useValue: processing },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => processing.reprocessarParciais.mockClear());
  it.each(['PLAYER', 'ORGANIZER'])('retorna 403 para %s', async (role) => {
    const response = await fetch(`${base}/admin/rodadas/25/reprocessar-parciais?temporada=2026`, { method: 'POST', headers: { Authorization: `Bearer ${role}` } });
    expect(response.status).toBe(403);
    expect(processing.reprocessarParciais).not.toHaveBeenCalled();
  });
  it('ADMIN executa e recebe somente resumo', async () => {
    const response = await fetch(`${base}/admin/rodadas/25/reprocessar-parciais?temporada=2026`, { method: 'POST', headers: { Authorization: 'Bearer PLATFORM_ADMIN' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
    expect(processing.reprocessarParciais).toHaveBeenCalledWith(25, 2026);
  });
  it('sem JWT retorna 401', async () => {
    expect((await fetch(`${base}/admin/rodadas/25/reprocessar-parciais?temporada=2026`, { method: 'POST' })).status).toBe(401);
  });
  it.each(['25', '39?temporada=2026', '25?temporada=abc', '25?temporada=0'])('valida parametros %s', async (input) => {
    const [round, query = ''] = input.split('?');
    const response = await fetch(`${base}/admin/rodadas/${round}/reprocessar-parciais?${query}`, { method: 'POST', headers: { Authorization: 'Bearer PLATFORM_ADMIN' } });
    expect(response.status).toBe(400);
    expect(processing.reprocessarParciais).not.toHaveBeenCalled();
  });
});
