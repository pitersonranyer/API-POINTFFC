import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminDesafiosController } from '../src/admin/admin-desafios.controller';
import { AdminDesafiosService } from '../src/admin/admin-desafios.service';
import { AdminDesafioPartidasService } from '../src/admin/admin-desafio-partidas.service';
import { CriarAdminDesafioDto } from '../src/admin/dto/admin-desafios.dto';
import { AdminGuard } from '../src/auth/admin.guard';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';

const datas = ['inicioInscricao', 'fimInscricao', 'dataInicio', 'dataFim'] as const;

describe('POST /admin/desafios sem datas (controller + service reais)', () => {
  let app: INestApplication;
  let base: string;
  let criar: jest.SpyInstance;
  const create = jest.fn();
  const post = (body: unknown) => fetch(`${base}/admin/desafios`, {
    method: 'POST', headers: { Authorization: 'Bearer admin-test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AdminDesafiosController], providers: [
      AdminDesafiosService, JwtAuthGuard, AdminGuard,
      { provide: AdminDesafioPartidasService, useValue: {} },
      { provide: PrismaService, useValue: { desafio: { create } } },
      { provide: AuthService, useValue: { authenticateJwt: async () => ({ idUsuario: 42, tipoUsuario: 'PLATFORM_ADMIN', status: 'ATIVO' }) } },
    ] }).compile();
    criar = jest.spyOn(module.get(AdminDesafiosService), 'criar');
    app = module.createNestApplication();
    // Mesmas opcoes de src/main.ts; sem skipMissingProperties ou conversao implicita.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); criar?.mockRestore(); });
  beforeEach(() => {
    jest.clearAllMocks();
    create.mockImplementation(async ({ data }) => ({ ...data, id: 7,
      criadoPor: { idUsuario: 42, nome: 'Admin' }, criadoEm: new Date(), atualizadoEm: new Date() }));
  });

  it.each([0, '0', '0.00'])('cria FREE com valor %j e gera as quatro datas somente no backend', async valorInscricao => {
    const body = { nome: 'Desafio Teste', tipoAcesso: 'FREE', valorInscricao };
    for (const campo of datas) expect(body).not.toHaveProperty(campo);
    const antes = Date.now();
    const response = await post(body);
    const result = await response.json();
    expect({ status: response.status, result }).toMatchObject({ status: 201, result: {
      id: 7, nome: body.nome, tipoAcesso: 'FREE', valorInscricao: '0.00', status: 'RASCUNHO', publicadoEm: null,
    } });
    expect(criar).toHaveBeenCalledTimes(1);
    const dto = criar.mock.calls[0][1] as CriarAdminDesafioDto;
    expect(dto).toBeInstanceOf(CriarAdminDesafioDto);
    for (const campo of datas) expect(dto[campo]).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    const persisted = create.mock.calls[0][0].data;
    expect(persisted.valorInscricao).toEqual(new Prisma.Decimal(0));
    for (const campo of datas) {
      expect(persisted[campo]).toBeInstanceOf(Date);
      expect(result[campo]).toBe(persisted[campo].toISOString());
    }
    expect(+persisted.inicioInscricao).toBeGreaterThanOrEqual(antes);
    expect(+persisted.inicioInscricao).toBeLessThanOrEqual(Date.now());
    expect(+persisted.inicioInscricao).toBeLessThan(+persisted.fimInscricao);
    expect(persisted.fimInscricao).toEqual(persisted.dataInicio);
    expect(+persisted.dataInicio).toBeLessThan(+persisted.dataFim);
  });

  it.each(datas)('data explicita invalida em %s retorna 400 antes do service', async campo => {
    const response = await post({ nome: 'Legado', tipoAcesso: 'FREE', valorInscricao: '0', [campo]: 'invalida' });
    const result = await response.json();
    expect(response.status).toBe(400);
    expect(result.message).toContain(`${campo} must be a valid ISO 8601 date string`);
    for (const outro of datas.filter(data => data !== campo)) {
      expect(result.message.some((mensagem: string) => mensagem.startsWith(outro))).toBe(false);
    }
    expect(criar).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('preserva criacao legada com datas explicitas validas', async () => {
    const periodo = { inicioInscricao: '2030-10-01T00:00:00.000Z', fimInscricao: '2030-10-02T00:00:00.000Z',
      dataInicio: '2030-10-02T00:00:00.000Z', dataFim: '2030-10-03T00:00:00.000Z' };
    const response = await post({ nome: 'Legado', tipoAcesso: 'FREE', valorInscricao: '0.00', ...periodo });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject(periodo);
    for (const campo of datas) expect(create.mock.calls[0][0].data[campo]).toEqual(new Date(periodo[campo]));
  });

  it.each([2, '2.00'])('preserva PAGO com valor %j e datas omitidas', async valorInscricao => {
    const response = await post({ nome: 'Pago', tipoAcesso: 'PAGO', valorInscricao });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: 7, tipoAcesso: 'PAGO', valorInscricao: '2.00', status: 'RASCUNHO' });
  });
});
