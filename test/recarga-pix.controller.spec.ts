import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RecargaPixController } from '../src/carteira/recarga-pix.controller';
import { RecargaPixWebhookController } from '../src/carteira/recarga-pix-webhook.controller';
import { RecargaPixService } from '../src/carteira/recarga-pix.service';

describe('Endpoints reais PIX', () => {
  let app: INestApplication;
  let base: string;
  const user = { idUsuario: 12, email: 'user@example.com', status: 'ATIVO' };
  const service = { criar: jest.fn(), consultar: jest.fn(), webhook: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [RecargaPixController, RecargaPixWebhookController],
      providers: [JwtAuthGuard, { provide: AuthService, useValue: { authenticateJwt: jest.fn(async () => user) } },
        { provide: RecargaPixService, useValue: service }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => undefined); service.criar.mockResolvedValue({ id: 1 }); service.consultar.mockResolvedValue({ id: 1 }); service.webhook.mockResolvedValue({ received: true }); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => app.close());

  async function post(body: unknown, authenticated = true) {
    return fetch(`${base}/carteira/recargas/pix`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': 'same-request-key-1234', ...(authenticated ? { Authorization: 'Bearer valid' } : {}),
    }, body: JSON.stringify(body) });
  }

  it('POST usa usuário autenticado e valor textual', async () => {
    expect((await post({ valor: '10.00' })).status).toBe(201);
    expect(service.criar).toHaveBeenCalledWith(user, '10.00', 'same-request-key-1234');
    expect(console.error).toHaveBeenCalledTimes(1);
    const args = jest.mocked(console.error).mock.calls[0];
    expect(args).toHaveLength(1);
    expect(args[0]).not.toMatch(/[\r\n]/);
    expect(JSON.parse(args[0])).toEqual({ marker: 'RECARGA_PIX_ENDPOINT_ENTER', level: 'error',
      timestamp: expect.any(String), usuarioId: 12 });
    expect(Number.isFinite(Date.parse(JSON.parse(args[0]).timestamp))).toBe(true);
    expect(jest.mocked(console.error).mock.invocationCallOrder[0]).toBeLessThan(service.criar.mock.invocationCallOrder[0]);
  });
  it('POST e GET sem autenticação retornam 401', async () => {
    expect((await post({ valor: '10.00' }, false)).status).toBe(401);
    expect((await fetch(`${base}/carteira/recargas/1`)).status).toBe(401);
    expect(service.criar).not.toHaveBeenCalled(); expect(service.consultar).not.toHaveBeenCalled();
  });
  it.each([{ valor: '10.00', usuarioId: 99 }, { valor: 10 }, { valor: '0.001' }, { valor: '10', carteiraId: 1 }])('não aceita identidade nem dados inválidos no body %j', async (body) => {
    expect((await post(body)).status).toBe(400); expect(service.criar).not.toHaveBeenCalled();
  });
  it('GET encaminha propriedade pelo usuário autenticado', async () => {
    expect((await fetch(`${base}/carteira/recargas/7`, { headers: { Authorization: 'Bearer valid' } })).status).toBe(200);
    expect(service.consultar).toHaveBeenCalledWith(12, 7);
  });
  it('webhook separado usa somente data.id da query assinada, ignorando body', async () => {
    const response = await fetch(`${base}/webhooks/mercado-pago/carteira?data.id=ORD1`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': 'sig', 'x-request-id': 'req' },
      body: JSON.stringify({ status: 'approved', data: { id: 'ORDOTHER' } }) });
    expect(response.status).toBe(200);
    expect(service.webhook).toHaveBeenCalledWith('sig', 'req', 'ORD1');
    expect(console.error).not.toHaveBeenCalled();
  });
  it('assinatura inválida retorna 401', async () => {
    service.webhook.mockRejectedValueOnce(new UnauthorizedException('Assinatura inválida'));
    expect((await fetch(`${base}/webhooks/mercado-pago/carteira?data.id=ORD1`, { method: 'POST' })).status).toBe(401);
    expect(service.webhook).toHaveBeenCalledWith(undefined, undefined, 'ORD1');
    expect(console.error).not.toHaveBeenCalled();
  });
});
