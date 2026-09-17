import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { InscricoesCompeticaoController } from '../src/ligas-competicoes/inscricoes-competicao.controller';
import { InscricoesCompeticaoService } from '../src/ligas-competicoes/inscricoes-competicao.service';

describe('Endpoints de inscricoes FREE', () => {
  let app: INestApplication;
  let base: string;
  const auth = { authenticateJwt: jest.fn() };
  const service = { criar: jest.fn(), minhas: jest.fn(), participantes: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [InscricoesCompeticaoController], providers: [
      JwtAuthGuard, { provide: AuthService, useValue: auth }, { provide: InscricoesCompeticaoService, useValue: service },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 10, status: 'ATIVO' });
    service.criar.mockResolvedValue({ inscricoes: [{ id: 8, timeIdCartola: 123 }], quantidade: 1 });
    service.minhas.mockResolvedValue([]);
    service.participantes.mockResolvedValue([]);
  });
  afterAll(() => app.close());

  const post = (body: unknown, authenticated = true) => fetch(`${base}/competicoes/1/inscricoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer valid' } : {}) },
    body: JSON.stringify(body),
  });

  it('POST exige autenticacao e deriva usuarioId do token', async () => {
    expect((await post({ timesCartolaIds: [123] }, false)).status).toBe(401);
    expect(service.criar).not.toHaveBeenCalled();
    expect((await post({ timesCartolaIds: [123] })).status).toBe(201);
    expect(service.criar).toHaveBeenCalledWith(1, 10, [123]);
  });

  it.each([
    { timesCartolaIds: [123], usuarioId: 99 }, { timesCartolaIds: [] }, { timesCartolaIds: '123' },
    { timesCartolaIds: [0] }, { timesCartolaIds: ['123'] }, { timesCartolaIds: [1.5] },
    { timesCartolaIds: [123, 123] }, {},
  ])(
    'POST rejeita corpo fora do contrato: %j', async body => {
      expect((await post(body)).status).toBe(400);
      expect(service.criar).not.toHaveBeenCalled();
    });

  it('GET minhas exige autenticacao e filtra pelo usuario do token', async () => {
    expect((await fetch(`${base}/competicoes/1/inscricoes/minhas`)).status).toBe(401);
    expect((await fetch(`${base}/competicoes/1/inscricoes/minhas`, { headers: { Authorization: 'Bearer valid' } })).status).toBe(200);
    expect(service.minhas).toHaveBeenCalledWith(1, 10);
  });

  it('GET participantes e publico', async () => {
    expect((await fetch(`${base}/competicoes/1/participantes`)).status).toBe(200);
    expect(service.participantes).toHaveBeenCalledWith(1);
    expect(auth.authenticateJwt).not.toHaveBeenCalled();
  });

  it.each(['/competicoes/0/participantes', '/competicoes/abc/inscricoes/minhas', '/competicoes/1.5/inscricoes'])(
    'rejeita ID de competicao invalido em %s', async path => {
      const response = path.endsWith('/inscricoes') ? await fetch(base + path, { method: 'POST', headers: {
        Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: JSON.stringify({ timesCartolaIds: [123] }) })
        : await fetch(base + path, { headers: { Authorization: 'Bearer valid' } });
      expect(response.status).toBe(400);
    });
});
