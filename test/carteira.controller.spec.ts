import { INestApplication, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CarteiraStatus, Prisma } from '@prisma/client';
import { request } from 'node:http';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { CarteiraController } from '../src/carteira/carteira.controller';
import { CarteiraService } from '../src/carteira/carteira.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('GET /carteira', () => {
  let app: INestApplication;
  let base: string;
  const user = { idUsuario: 12, email: 'user@example.com', status: 'ATIVO' };
  const auth = { authenticateJwt: jest.fn() };
  const service = { obterOuCriar: jest.fn() };
  const carteira = (disponivel = '10.5', bloqueado = '0', status: CarteiraStatus = CarteiraStatus.ATIVA) => ({
    id: 7, usuarioId: 12, saldoDisponivel: new Prisma.Decimal(disponivel),
    saldoBloqueado: new Prisma.Decimal(bloqueado), status, criadoEm: new Date(), atualizadoEm: new Date(),
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CarteiraController],
      providers: [JwtAuthGuard, { provide: AuthService, useValue: auth }, { provide: CarteiraService, useValue: service }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    auth.authenticateJwt.mockResolvedValue(user);
    service.obterOuCriar.mockResolvedValue(carteira());
  });
  afterAll(() => app.close());

  const get = (suffix = '') => fetch(`${base}/carteira${suffix}`, { headers: { Authorization: 'Bearer valid' } });

  it('exige autenticacao antes de consultar ou criar carteira', async () => {
    expect((await fetch(`${base}/carteira?usuarioId=99`)).status).toBe(401);
    expect(service.obterOuCriar).not.toHaveBeenCalled();
  });

  it('rejeita token invalido', async () => {
    auth.authenticateJwt.mockRejectedValueOnce(new UnauthorizedException());
    expect((await get()).status).toBe(401);
    expect(service.obterOuCriar).not.toHaveBeenCalled();
  });

  it('consulta carteira existente pelo usuario autenticado e retorna somente o contrato publico', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saldoDisponivel: '10.50', saldoBloqueado: '0.00', status: 'ATIVA' });
    expect(auth.authenticateJwt).toHaveBeenCalledWith('valid');
    expect(service.obterOuCriar).toHaveBeenCalledTimes(1);
    expect(service.obterOuCriar).toHaveBeenCalledWith(12);
  });

  it('ignora identidade enviada na query', async () => {
    expect((await get('?usuarioId=99&carteiraId=88')).status).toBe(200);
    expect(service.obterOuCriar).toHaveBeenCalledWith(12);
  });

  it('nao oferece rota de consulta por identidade nos params', async () => {
    expect((await get('/99')).status).toBe(404);
    expect(service.obterOuCriar).not.toHaveBeenCalled();
  });

  it('ignora identidade enviada no body de GET', async () => {
    const body = JSON.stringify({ usuarioId: 99, carteiraId: 88 });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/carteira`, { method: 'GET', headers: {
        Authorization: 'Bearer valid', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); });
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(200);
    expect(service.obterOuCriar).toHaveBeenCalledWith(12);
  });

  it('usuario sem carteira passa pela criacao existente em obterOuCriar', async () => {
    const nova = carteira('0', '0');
    const tx = {
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id_usuario: 12 }]).mockResolvedValueOnce([nova]),
      carteira: { upsert: jest.fn().mockResolvedValue(nova) },
    };
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
    const realService = new CarteiraService(prisma as unknown as PrismaService);
    service.obterOuCriar.mockImplementationOnce((id: number) => realService.obterOuCriar(id));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saldoDisponivel: '0.00', saldoBloqueado: '0.00', status: 'ATIVA' });
    expect(service.obterOuCriar).toHaveBeenCalledWith(12);
    expect(tx.carteira.upsert).toHaveBeenCalledWith({ where: { usuarioId: 12 }, create: { usuarioId: 12 }, update: {} });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['0', '0', '0.00', '0.00'],
    ['0.1', '2.5', '0.10', '2.50'],
    ['9999999999.99', '0.01', '9999999999.99', '0.01'],
  ])('serializa Decimal %s / %s como strings de duas casas', async (disponivel, bloqueado, esperadoDisponivel, esperadoBloqueado) => {
    service.obterOuCriar.mockResolvedValueOnce(carteira(disponivel, bloqueado));
    expect(await (await get()).json()).toEqual({ saldoDisponivel: esperadoDisponivel, saldoBloqueado: esperadoBloqueado, status: 'ATIVA' });
  });

  it('retorna estado BLOQUEADA sem impedir consulta', async () => {
    service.obterOuCriar.mockResolvedValueOnce(carteira('10', '3', CarteiraStatus.BLOQUEADA));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saldoDisponivel: '10.00', saldoBloqueado: '3.00', status: 'BLOQUEADA' });
  });

  it('preserva tratamento de erros HTTP do servico', async () => {
    service.obterOuCriar.mockRejectedValueOnce(new NotFoundException('Usuário não encontrado'));
    expect((await get()).status).toBe(404);
  });
});
