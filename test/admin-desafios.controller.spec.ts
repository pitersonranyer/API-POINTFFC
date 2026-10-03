import { INestApplication, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminDesafiosController } from '../src/admin/admin-desafios.controller';
import { AdminDesafiosService } from '../src/admin/admin-desafios.service';
import { AdminDesafioPartidasService } from '../src/admin/admin-desafio-partidas.service';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';

const body = {
  nome: 'Desafio outubro', tipoAcesso: 'FREE', valorInscricao: '0.00',
  inicioInscricao: '2026-10-01T00:00:00Z', fimInscricao: '2026-10-02T00:00:00Z',
  dataInicio: '2026-10-02T00:00:00Z', dataFim: '2026-10-03T00:00:00Z',
};

describe('AdminDesafiosController HTTP', () => {
  let app: INestApplication;
  let base: string;
  const service = { criar: jest.fn(), listar: jest.fn(), buscar: jest.fn(), atualizar: jest.fn(), publicar: jest.fn(), cancelar: jest.fn() };
  const request = (method: string, path: string, data?: unknown, token: string | null = 'PLATFORM_ADMIN') => fetch(`${base}/admin/desafios${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminDesafiosController], providers: [
      JwtAuthGuard, AdminGuard, { provide: AdminDesafiosService, useValue: service },
      { provide: AdminDesafioPartidasService, useValue: {} },
      { provide: AuthService, useValue: { authenticateJwt: jest.fn(async (token: string) => {
        if (token === 'INVALIDO') throw new UnauthorizedException();
        const [tipoUsuario, status = 'ATIVO'] = token.split(':');
        return { idUsuario: 42, tipoUsuario, status };
      }) } },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    for (const fn of Object.values(service)) fn.mockResolvedValue({ id: 7 });
  });

  it.each([
    ['POST', '', body, 201], ['GET', '', undefined, 200], ['GET', '/7', undefined, 200],
    ['PATCH', '/7', { nome: 'Novo' }, 200], ['POST', '/7/publicar', {}, 201], ['POST', '/7/cancelar', {}, 201],
  ])('protege %s %s com JWT e PLATFORM_ADMIN ativo', async (method, path, data, status) => {
    expect((await request(method as string, path as string, data, null)).status).toBe(401);
    expect((await request(method as string, path as string, data, 'INVALIDO')).status).toBe(401);
    for (const token of ['PLAYER', 'ORGANIZER', 'PLATFORM_ADMIN:INATIVO', 'PLATFORM_ADMIN:BLOQUEADO']) {
      expect((await request(method as string, path as string, data, token)).status).toBe(403);
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    expect((await request(method as string, path as string, data)).status).toBe(status);
  });

  it('usa criador autenticado e aceita FREE/PAGO com decimais textuais', async () => {
    expect((await request('POST', '', body)).status).toBe(201);
    expect(service.criar).toHaveBeenCalledWith(42, expect.objectContaining(body));
    expect((await request('POST', '', { ...body, tipoAcesso: 'PAGO', valorInscricao: '2.00' })).status).toBe(201);
    expect(service.criar).toHaveBeenLastCalledWith(42, expect.objectContaining({ valorInscricao: '2.00' }));
  });

  it('permite Admin configurar limite por usuario na criacao e edicao', async () => {
    expect((await request('POST', '', { ...body, limiteInscricoesPorUsuario: 3 })).status).toBe(201);
    expect(service.criar).toHaveBeenCalledWith(42, expect.objectContaining({ limiteInscricoesPorUsuario: 3 }));
    expect((await request('PATCH', '/7', { limiteInscricoesPorUsuario: 2 })).status).toBe(200);
    expect(service.atualizar).toHaveBeenCalledWith(7, { limiteInscricoesPorUsuario: 2 });
  });

  it.each([null, 0, -1, 1.5, '2', 4294967296])('rejeita limite por usuario invalido: %j', async limiteInscricoesPorUsuario => {
    expect((await request('POST', '', { ...body, limiteInscricoesPorUsuario })).status).toBe(400);
    expect((await request('PATCH', '/7', { limiteInscricoesPorUsuario })).status).toBe(400);
    expect(service.criar).not.toHaveBeenCalled(); expect(service.atualizar).not.toHaveBeenCalled();
  });

  it('aceita criar e editar apenas dados basicos, sem as quatro datas', async () => {
    const basico = { nome: 'Desafio simplificado', tipoAcesso: 'FREE', valorInscricao: '0' };
    expect((await request('POST', '', basico)).status).toBe(201);
    expect(service.criar).toHaveBeenCalledWith(42, basico);
    expect((await request('PATCH', '/7', basico)).status).toBe(200);
  });

  it.each(['id', 'status', 'criadoPorUsuarioId', 'criadoPorId', 'criadoPor', 'publicadoEm', 'createdAt', 'updatedAt', 'criadoEm', 'atualizadoEm'])
  ('rejeita campo controlado pelo servidor: %s', async campo => {
    expect((await request('POST', '', { ...body, [campo]: 1 })).status).toBe(400);
    expect((await request('PATCH', '/7', { [campo]: 1 })).status).toBe(400);
    expect(service.criar).not.toHaveBeenCalled();
    expect(service.atualizar).not.toHaveBeenCalled();
  });

  it.each([
    { nome: '  ' }, { nome: null }, { tipoAcesso: null }, { tipoAcesso: 'OUTRO' },
    { valorInscricao: null }, { valorInscricao: -1 }, { valorInscricao: 0.001 }, { valorInscricao: true }, { valorInscricao: '2.001' },
    { valorInscricao: '10000000000.00' }, { valorInscricao: '-1.00' }, { valorInscricao: '2,00' },
    { inicioInscricao: null }, { inicioInscricao: 0 }, { inicioInscricao: '2026-02-30T00:00:00Z' },
    { fimInscricao: 'invalida' }, { dataInicio: '2026-10-02' }, { dataFim: null },
    { limiteParticipantes: 0 }, { limiteParticipantes: -1 }, { limiteParticipantes: 1.5 },
    { limiteParticipantes: 4294967296 },
  ])('valida campos tanto na criacao quanto no PATCH: %j', async change => {
    expect((await request('POST', '', { ...body, ...change })).status).toBe(400);
    expect((await request('PATCH', '/7', change)).status).toBe(400);
    expect(service.criar).not.toHaveBeenCalled();
    expect(service.atualizar).not.toHaveBeenCalled();
  });

  it('aceita NULL nos campos opcionais e PATCH parcial', async () => {
    expect((await request('PATCH', '/7', { descricao: null, limiteParticipantes: null })).status).toBe(200);
    expect(service.atualizar).toHaveBeenCalledWith(7, { descricao: null, limiteParticipantes: null });
    expect((await request('POST', '', { ...body, descricao: null, limiteParticipantes: null })).status).toBe(201);
  });

  it('aplica defaults, filtros e limites de paginacao', async () => {
    expect((await request('GET', '')).status).toBe(200);
    expect(service.listar).toHaveBeenCalledWith({ pagina: 1, limite: 20 });
    expect((await request('GET', '?pagina=2&limite=10&status=ABERTO&tipoAcesso=PAGO')).status).toBe(200);
    expect(service.listar).toHaveBeenLastCalledWith({ pagina: 2, limite: 10, status: 'ABERTO', tipoAcesso: 'PAGO' });
    for (const query of ['pagina=0', 'pagina=1.5', 'limite=101', 'status=OUTRO', 'tipoAcesso=OUTRO']) {
      expect((await request('GET', `?${query}`)).status).toBe(400);
    }
  });

  it('retorna 404 e rejeita IDs invalidos', async () => {
    service.buscar.mockRejectedValueOnce(new NotFoundException('Desafio nao encontrado.'));
    expect((await request('GET', '/999')).status).toBe(404);
    for (const id of ['0', '-1', 'abc', '1.5', '4294967296']) {
      expect((await request('GET', `/${id}`)).status).toBe(400);
    }
  });

  it('acoes aceitam body vazio e rejeitam status/configuracao enviados', async () => {
    for (const acao of ['publicar', 'cancelar']) {
      expect((await request('POST', `/7/${acao}`)).status).toBe(201);
      expect((await request('POST', `/7/${acao}`, { status: 'ENCERRADO' })).status).toBe(400);
    }
  });

  it('nao oferece DELETE de Desafio', async () => {
    expect((await request('DELETE', '/7')).status).toBe(404);
  });
});
