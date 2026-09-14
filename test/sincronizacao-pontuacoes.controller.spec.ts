import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { SincronizacaoPontuacoesController } from '../src/ligas-competicoes/sincronizacao-pontuacoes.controller';
import { SincronizacaoPontuacoesService } from '../src/ligas-competicoes/sincronizacao-pontuacoes.service';

describe('POST /competicoes/:id/sincronizar-pontuacoes', () => {
  let app: INestApplication;
  let base: string;
  const resultado = { competicaoId: 7, rodada: 27, quantidadeInscricoesAtivas: 2,
    quantidadeAtualizadas: 1, quantidadePendentes: 1,
    pendencias: [{ inscricaoId: 2, timeIdCartola: 202, nomeTime: 'Verde', motivo: 'PONTUACAO_INDISPONIVEL' }] };
  const service = { sincronizarPontuacoesCompeticao: jest.fn(async () => resultado) };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [SincronizacaoPontuacoesController], providers: [
      JwtAuthGuard, AdminGuard,
      { provide: AuthService, useValue: { authenticateJwt: jest.fn(async (token: string) => ({ tipoUsuario: token, status: 'ATIVO' })) } },
      { provide: SincronizacaoPontuacoesService, useValue: service },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => app?.close());
  beforeEach(() => service.sincronizarPontuacoesCompeticao.mockClear());

  it('exige JWT e PLATFORM_ADMIN', async () => {
    expect((await fetch(`${base}/competicoes/7/sincronizar-pontuacoes`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/competicoes/7/sincronizar-pontuacoes`, { method: 'POST', headers: { Authorization: 'Bearer PLAYER' } })).status).toBe(403);
    expect(service.sincronizarPontuacoesCompeticao).not.toHaveBeenCalled();
  });

  it('retorna contagens e pendencias ao administrador', async () => {
    const response = await fetch(`${base}/competicoes/7/sincronizar-pontuacoes`, { method: 'POST', headers: { Authorization: 'Bearer PLATFORM_ADMIN' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resultado);
    expect(service.sincronizarPontuacoesCompeticao).toHaveBeenCalledWith(7);
  });

  it('valida o identificador', async () => {
    expect((await fetch(`${base}/competicoes/abc/sincronizar-pontuacoes`, { method: 'POST', headers: { Authorization: 'Bearer PLATFORM_ADMIN' } })).status).toBe(400);
    expect(service.sincronizarPontuacoesCompeticao).not.toHaveBeenCalled();
  });
});
