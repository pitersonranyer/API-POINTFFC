import 'reflect-metadata';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { OptionalJwtAuthGuard } from '../src/auth/optional-jwt-auth.guard';
import { ResumoCompeticaoController } from '../src/ligas-competicoes/resumo-competicao.controller';
import { ResumoCompeticaoService } from '../src/ligas-competicoes/resumo-competicao.service';

describe('GET /competicoes/:id/resumo', () => {
  let app: INestApplication;
  let base: string;
  const auth = { authenticateJwt: jest.fn() };
  const service = { consultar: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ResumoCompeticaoController], providers: [
      OptionalJwtAuthGuard, { provide: AuthService, useValue: auth }, { provide: ResumoCompeticaoService, useValue: service },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 10, status: 'ATIVO' });
    service.consultar.mockResolvedValue({ competicao: { id: 1 }, inscritos: { quantidade: 0 }, premiacao: [] });
  });
  afterAll(() => app.close());

  it('aceita consulta publica sem calcular usuario', async () => {
    const response = await fetch(`${base}/competicoes/1/resumo`);
    expect(response.status).toBe(200);
    expect(service.consultar).toHaveBeenCalledWith(1, undefined);
    expect(auth.authenticateJwt).not.toHaveBeenCalled();
  });

  it('usa usuario autenticado quando JWT esta presente', async () => {
    const response = await fetch(`${base}/competicoes/1/resumo`, { headers: { Authorization: 'Bearer valid' } });
    expect(response.status).toBe(200);
    expect(auth.authenticateJwt).toHaveBeenCalledWith('valid');
    expect(service.consultar).toHaveBeenCalledWith(1, 10);
  });

  it('rejeita JWT invalido, em vez de devolver resumo publico', async () => {
    auth.authenticateJwt.mockRejectedValueOnce(new UnauthorizedException('Token invalido'));
    expect((await fetch(`${base}/competicoes/1/resumo`, { headers: { Authorization: 'Bearer invalid' } })).status).toBe(401);
    expect(service.consultar).not.toHaveBeenCalled();
  });

  it('rejeita Authorization malformado', async () => {
    expect((await fetch(`${base}/competicoes/1/resumo`, { headers: { Authorization: 'invalid' } })).status).toBe(401);
    expect(service.consultar).not.toHaveBeenCalled();
  });

  it('mantem usuario bloqueado proibido', async () => {
    auth.authenticateJwt.mockResolvedValueOnce({ idUsuario: 10, status: 'BLOQUEADO' });
    expect((await fetch(`${base}/competicoes/1/resumo`, { headers: { Authorization: 'Bearer valid' } })).status).toBe(403);
    expect(service.consultar).not.toHaveBeenCalled();
  });

  it.each(['/competicoes/0/resumo', '/competicoes/abc/resumo', '/competicoes/4294967296/resumo'])(
    'rejeita ID invalido: %s', async path => {
      expect((await fetch(base + path)).status).toBe(400);
      expect(service.consultar).not.toHaveBeenCalled();
    });
});
