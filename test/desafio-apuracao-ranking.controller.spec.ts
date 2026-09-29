import { ConflictException, INestApplication, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminDesafioApuracaoController } from '../src/admin/admin-desafio-apuracao.controller';
import { AdminDesafioApuracaoService } from '../src/admin/admin-desafio-apuracao.service';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { DesafioRankingController } from '../src/desafios/desafio-ranking.controller';
import { DesafioRankingService } from '../src/desafios/desafio-ranking.service';

describe('Apuracao administrativa e ranking publico HTTP', () => {
  let app: INestApplication;
  let base: string;
  const apuracao = { apurar: jest.fn() };
  const ranking = { consultar: jest.fn() };
  const auth = { authenticateJwt: jest.fn() };
  const request = (method: string, path: string, token?: string, body?: unknown) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminDesafioApuracaoController, DesafioRankingController],
      providers: [JwtAuthGuard, AdminGuard, { provide: AuthService, useValue: auth },
        { provide: AdminDesafioApuracaoService, useValue: apuracao }, { provide: DesafioRankingService, useValue: ranking }] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    auth.authenticateJwt.mockImplementation(async (token: string) => {
      if (token === 'INVALIDO') throw new UnauthorizedException();
      const [tipoUsuario, status = 'ATIVO'] = token.split(':'); return { idUsuario: 42, tipoUsuario, status };
    });
    apuracao.apurar.mockResolvedValue({ desafioId: 7, status: 'ENCERRADO', partidasApuradas: 1, pendencias: [] });
    ranking.consultar.mockResolvedValue({ desafioId: 7, ranking: [], totalPartidasValidas: 1 });
  });

  it('ranking e publico sem JWT, com paginacao', async () => {
    const response = await request('GET', '/desafios/7/ranking?pagina=2&limite=10');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ desafioId: 7, ranking: [] });
    expect(ranking.consultar).toHaveBeenCalledWith(7, { pagina: 2, limite: 10 });
    expect(auth.authenticateJwt).not.toHaveBeenCalled();
  });

  it('permite apuracao somente a PLATFORM_ADMIN ativo, com body ausente ou {}', async () => {
    expect((await request('POST', '/admin/desafios/7/apurar')).status).toBe(401);
    expect((await request('POST', '/admin/desafios/7/apurar', 'INVALIDO')).status).toBe(401);
    for (const token of ['PLAYER', 'ORGANIZER', 'PLATFORM_ADMIN:INATIVO', 'PLATFORM_ADMIN:BLOQUEADO']) {
      expect((await request('POST', '/admin/desafios/7/apurar', token)).status).toBe(403);
    }
    expect(apuracao.apurar).not.toHaveBeenCalled();
    for (const body of [undefined, {}]) {
      expect((await request('POST', '/admin/desafios/7/apurar', 'PLATFORM_ADMIN', body)).status).toBe(201);
    }
    expect(apuracao.apurar).toHaveBeenCalledWith(7);
  });

  it.each(['resultado', 'golsMandante', 'status', 'pontos', 'usuarioId', 'partidas'])('nao aceita resultado manual: %s', async campo => {
    expect((await request('POST', '/admin/desafios/7/apurar', 'PLATFORM_ADMIN', { [campo]: 1 })).status).toBe(400);
    expect(apuracao.apurar).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'abc', '4294967296'])('rejeita ID invalido nas duas rotas: %s', async id => {
    expect((await request('GET', `/desafios/${id}/ranking`)).status).toBe(400);
    expect((await request('POST', `/admin/desafios/${id}/apurar`, 'PLATFORM_ADMIN')).status).toBe(400);
  });

  it.each(['pagina=0', 'pagina=1.5', 'limite=101', 'limite=0', 'usuarioId=42', 'status=RASCUNHO'])
  ('rejeita query invalida no ranking: %s', async query => {
    expect((await request('GET', `/desafios/7/ranking?${query}`)).status).toBe(400);
    expect(ranking.consultar).not.toHaveBeenCalled();
  });

  it('propaga 404 publico e 409 administrativo', async () => {
    ranking.consultar.mockRejectedValueOnce(new NotFoundException());
    expect((await request('GET', '/desafios/7/ranking')).status).toBe(404);
    apuracao.apurar.mockRejectedValueOnce(new ConflictException());
    expect((await request('POST', '/admin/desafios/7/apurar', 'PLATFORM_ADMIN')).status).toBe(409);
  });
});
