import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { request } from 'node:http';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { CarteiraController } from '../src/carteira/carteira.controller';
import { CarteiraService } from '../src/carteira/carteira.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('GET /carteira/extrato', () => {
  let app: INestApplication;
  let base: string;
  let service: CarteiraService;
  const auth = { authenticateJwt: jest.fn() };
  const tx = {
    $queryRaw: jest.fn(),
    carteira: { upsert: jest.fn(), update: jest.fn() },
    movimentacaoCarteira: { count: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
  const movimento = {
    id: 123, tipo: 'CREDITO', origem: 'RECARGA_PIX', status: 'CONFIRMADA', descricao: null,
    valor: new Prisma.Decimal('10'), saldoAnterior: new Prisma.Decimal('20'),
    saldoPosterior: new Prisma.Decimal('30'), criadoEm: new Date('2026-09-10T12:00:00Z'),
    carteiraId: 7, usuarioId: 12, recargaId: 2, referenciaId: 'private', idPagamentoExterno: 'private',
  };

  beforeAll(async () => {
    service = new CarteiraService(prisma as unknown as PrismaService);
    const module = await Test.createTestingModule({
      controllers: [CarteiraController],
      providers: [JwtAuthGuard, { provide: AuthService, useValue: auth }, { provide: CarteiraService, useValue: service }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/carteira/extrato`;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 12, status: 'ATIVO' });
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ id_usuario: 12 }]).mockResolvedValueOnce([{ id: 7, usuarioId: 12 }]);
    tx.movimentacaoCarteira.count.mockResolvedValue(35);
    tx.movimentacaoCarteira.findMany.mockResolvedValue([movimento]);
  });
  afterAll(() => app.close());
  const get = (query = '') => fetch(`${base}${query}`, { headers: { Authorization: 'Bearer valid' } });

  it('exige token antes de acessar a carteira', async () => {
    expect((await fetch(base)).status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejeita token invalido', async () => {
    auth.authenticateJwt.mockRejectedValueOnce(new UnauthorizedException());
    expect((await get()).status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('usa identidade autenticada, defaults e contrato publico com valores decimais', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ id: 123, tipo: 'CREDITO', origem: 'RECARGA_PIX', status: 'CONFIRMADA', descricao: null,
        valor: '10.00', saldoAnterior: '20.00', saldoPosterior: '30.00', criadoEm: '2026-09-10T12:00:00.000Z' }],
      page: 1, limit: 20, total: 35, totalPages: 2,
    });
    expect(tx.carteira.upsert).toHaveBeenCalledWith({ where: { usuarioId: 12 }, create: { usuarioId: 12 }, update: {} });
    expect(tx.movimentacaoCarteira.findMany).toHaveBeenCalledWith({
      where: { carteiraId: 7 }, skip: 0, take: 20, orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
      select: { id: true, tipo: true, origem: true, valor: true, saldoAnterior: true,
        saldoPosterior: true, descricao: true, status: true, criadoEm: true },
    });
    expect(tx.movimentacaoCarteira.count).toHaveBeenCalledWith({ where: { carteiraId: 7 } });
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(tx.carteira.update).not.toHaveBeenCalled();
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
  });
  it.each(['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=', 'page=1&page=2',
    'page=9007199254740992', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=',
    'limit=101', 'limit=20&limit=30', 'page=1e2', 'limit=0x10',
    'page=9007199254740991&limit=100'])('rejeita query invalida %s sem acessar carteira', async (query) => {
    expect((await get(`?${query}`)).status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['usuarioId=99', 'carteiraId=88', 'recargaId=2'])('rejeita identidade externa %s', async (query) => {
    expect((await get(`?${query}`)).status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('nao oferece consulta por ID no caminho', async () => {
    expect((await get('/99')).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('ignora identidade no body e consulta apenas usuario autenticado', async () => {
    const body = JSON.stringify({ usuarioId: 99, carteiraId: 88 });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base, { method: 'GET', headers: {
        Authorization: 'Bearer valid', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); });
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(200);
    expect(tx.carteira.upsert).toHaveBeenCalledWith({ where: { usuarioId: 12 }, create: { usuarioId: 12 }, update: {} });
    expect(tx.movimentacaoCarteira.count).toHaveBeenCalledWith({ where: { carteiraId: 7 } });
  });
  it('busca somente a segunda pagina e calcula o total de paginas', async () => {
    const response = await get('?page=2&limit=10');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ page: 2, limit: 10, total: 35, totalPages: 4 });
    expect(tx.movimentacaoCarteira.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
  });
  it('aceita limite maximo 100', async () => {
    expect((await get('?limit=100')).status).toBe(200);
    expect(tx.movimentacaoCarteira.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
  it('carteira sem movimentos retorna vazio sem escrita financeira', async () => {
    tx.movimentacaoCarteira.count.mockResolvedValueOnce(0);
    tx.movimentacaoCarteira.findMany.mockResolvedValueOnce([]);
    expect(await (await get()).json()).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    expect(tx.carteira.upsert).toHaveBeenCalled();
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
    expect(tx.carteira.update).not.toHaveBeenCalled();
  });
  it('pagina alem do total retorna vazio mantendo metadados', async () => {
    tx.movimentacaoCarteira.findMany.mockResolvedValueOnce([]);
    expect(await (await get('?page=3')).json()).toEqual({ items: [], page: 3, limit: 20, total: 35, totalPages: 2 });
  });
  it.each(['0', '0.1', '10.50', '9999999999.99'])('preserva precisao monetaria de %s', async (valor) => {
    const decimal = new Prisma.Decimal(valor);
    tx.movimentacaoCarteira.findMany.mockResolvedValueOnce([{ ...movimento, valor: decimal, saldoAnterior: decimal, saldoPosterior: decimal }]);
    const result = await (await get()).json() as { items: Record<string, unknown>[] };
    for (const campo of ['valor', 'saldoAnterior', 'saldoPosterior']) {
      expect(result.items[0][campo]).toBe(decimal.toFixed(2));
    }
  });
});
