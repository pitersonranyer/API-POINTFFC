import { ConflictException, INestApplication, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../src/auth/optional-jwt-auth.guard';
import { DesafiosController } from '../src/desafios/desafios.controller';
import { DesafiosService } from '../src/desafios/desafios.service';

describe('Desafios publicos HTTP', () => {
  let app: INestApplication;
  let base: string;
  const auth = { authenticateJwt: jest.fn() };
  const service = { listar: jest.fn(), buscar: jest.fn(), salvarPalpite: jest.fn(), criarCartela: jest.fn() };
  const request = (method: string, path: string, body?: unknown, authorization?: string) => fetch(`${base}/desafios${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(authorization === undefined ? {} : { Authorization: authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DesafiosController], providers: [
      JwtAuthGuard, OptionalJwtAuthGuard, { provide: AuthService, useValue: auth }, { provide: DesafiosService, useValue: service },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 42, status: 'ATIVO', tipoUsuario: 'PLAYER' });
    service.listar.mockResolvedValue({ itens: [{ id: 7, nome: 'Desafio' }], paginacao: { pagina: 1, limite: 20, total: 1, totalPaginas: 1 } });
    service.buscar.mockImplementation(async (id: number, usuarioId?: number) => ({ id, partidas: [{ id: 1,
      fechamentoEm: '2030-10-03T16:00:00.000Z', podeAlterarPalpite: usuarioId !== undefined,
      ...(usuarioId === undefined ? {} : { meuPalpite: 'CASA' }) }] }));
    service.salvarPalpite.mockResolvedValue({ desafioId: 7, partidaId: 1, palpite: 'CASA',
      fechamentoEm: '2030-10-03T16:00:00.000Z', podeAlterarPalpite: true });
  });

  it('lista publicamente sem JWT com paginacao padrao', async () => {
    const response = await request('GET', '');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ itens: [{ id: 7 }], paginacao: { pagina: 1, limite: 20 } });
    expect(service.listar).toHaveBeenCalledWith({ pagina: 1, limite: 20 });
    expect(auth.authenticateJwt).not.toHaveBeenCalled();
  });

  it('converte paginacao e aceita filtro FREE/PAGO', async () => {
    const response = await request('GET', '?pagina=2&limite=10&tipoAcesso=PAGO');
    expect(response.status).toBe(200);
    expect(service.listar).toHaveBeenCalledWith({ pagina: 2, limite: 10, tipoAcesso: 'PAGO' });
  });

  it('detalhe publico sem JWT nao inclui palpite pessoal', async () => {
    const response = await request('GET', '/7');
    expect(response.status).toBe(200);
    expect((await response.json()).partidas[0]).not.toHaveProperty('meuPalpite');
    expect(service.buscar).toHaveBeenCalledWith(7, undefined);
    expect(auth.authenticateJwt).not.toHaveBeenCalled();
  });

  it('detalhe com JWT passa apenas o usuario autenticado e impede cache de dados pessoais', async () => {
    const response = await request('GET', '/7', undefined, 'Bearer valid');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).partidas[0]).toMatchObject({ meuPalpite: 'CASA', podeAlterarPalpite: true,
      fechamentoEm: '2030-10-03T16:00:00.000Z' });
    expect(auth.authenticateJwt).toHaveBeenCalledWith('valid');
    expect(service.buscar).toHaveBeenCalledWith(7, 42);
  });

  it.each(['CASA', 'EMPATE', 'FORA'])('salva %s para o proprio usuario com PUT e retorna 200', async palpite => {
    const response = await request('PUT', '/7/partidas/1/palpite', { palpite }, 'Bearer valid');
    expect(response.status).toBe(200);
    expect(service.salvarPalpite).toHaveBeenCalledWith(7, 1, 42, { palpite });
  });

  it('exige JWT para salvar', async () => {
    const response = await request('PUT', '/7/partidas/1/palpite', { palpite: 'CASA' });
    expect(response.status).toBe(401);
    expect(service.salvarPalpite).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT'])('rejeita JWT invalido/expirado em %s sem tratar como anonimo', async method => {
    auth.authenticateJwt.mockRejectedValue(new UnauthorizedException('Token invalido ou expirado'));
    const response = await request(method, method === 'GET' ? '/7' : '/7/partidas/1/palpite',
      method === 'GET' ? undefined : { palpite: 'CASA' }, 'Bearer invalid');
    expect(response.status).toBe(401);
    expect(service.buscar).not.toHaveBeenCalled();
    expect(service.salvarPalpite).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT'])('rejeita Authorization malformado em %s', async method => {
    const response = await request(method, method === 'GET' ? '/7' : '/7/partidas/1/palpite',
      method === 'GET' ? undefined : { palpite: 'CASA' }, 'invalid');
    expect(response.status).toBe(401);
    expect(auth.authenticateJwt).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT'])('bloqueia usuario BLOQUEADO em %s', async method => {
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 42, status: 'BLOQUEADO' });
    const response = await request(method, method === 'GET' ? '/7' : '/7/partidas/1/palpite',
      method === 'GET' ? undefined : { palpite: 'CASA' }, 'Bearer valid');
    expect(response.status).toBe(403);
    expect(service.buscar).not.toHaveBeenCalled();
    expect(service.salvarPalpite).not.toHaveBeenCalled();
  });

  it.each([{}, { palpite: null }, { palpite: 'casa' }, { palpite: 'HOME' }, { palpite: 1 }, { palpite: ['CASA'] }])
  ('rejeita palpite invalido: %j', async body => {
    expect((await request('PUT', '/7/partidas/1/palpite', body, 'Bearer valid')).status).toBe(400);
    expect(service.salvarPalpite).not.toHaveBeenCalled();
  });

  it.each(['usuarioId', 'desafioId', 'desafioPartidaId', 'id', 'pontos', 'apurado', 'dataInicio', 'fechamentoEm'])
  ('nao aceita controle/identidade pelo body: %s', async campo => {
    expect((await request('PUT', '/7/partidas/1/palpite', { palpite: 'CASA', [campo]: 999 }, 'Bearer valid')).status).toBe(400);
    expect(service.salvarPalpite).not.toHaveBeenCalled();
  });

  it('aceita inscricaoId para selecionar a cartela e passa somente o dono autenticado', async () => {
    expect((await request('PUT', '/7/partidas/1/palpite', { palpite: 'FORA', inscricaoId: 123 }, 'Bearer valid')).status).toBe(200);
    expect(service.salvarPalpite).toHaveBeenCalledWith(7, 1, 42, { palpite: 'FORA', inscricaoId: 123 });
  });

  it.each([null, 0, -1, 1.5, '123', 4294967296])('rejeita selecao invalida de cartela: %j', async inscricaoId => {
    expect((await request('PUT', '/7/partidas/1/palpite', { palpite: 'CASA', inscricaoId }, 'Bearer valid')).status).toBe(400);
    expect(service.salvarPalpite).not.toHaveBeenCalled();
  });

  it('cria rascunho autenticado com chave de idempotencia, sem identidade no body', async () => {
    service.criarCartela.mockResolvedValue({ id: 123, numero: 2, nome: 'Palpite 2', status: 'RASCUNHO' });
    const response = await request('POST', '/7/inscricoes', { chaveIdempotencia: 'nova-2' }, 'Bearer valid');
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: 123, numero: 2, status: 'RASCUNHO' });
    expect(service.criarCartela).toHaveBeenCalledWith(7, 42, { chaveIdempotencia: 'nova-2' });
  });

  it.each([{}, { chaveIdempotencia: '' }, { chaveIdempotencia: 'x'.repeat(101) },
    { chaveIdempotencia: 'a', usuarioId: 43 }, { chaveIdempotencia: 'a', sequencia: 2 }])
  ('rejeita criacao de cartela invalida: %j', async body => {
    expect((await request('POST', '/7/inscricoes', body, 'Bearer valid')).status).toBe(400);
    expect(service.criarCartela).not.toHaveBeenCalled();
  });

  it('exige autenticacao para criar cartela', async () => {
    expect((await request('POST', '/7/inscricoes', { chaveIdempotencia: 'a' })).status).toBe(401);
    expect(service.criarCartela).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.2', 'abc', '4294967296', '1e2'])('valida IDs do detalhe e da partida: %s', async id => {
    expect((await request('GET', `/${id}`)).status).toBe(400);
    expect((await request('PUT', `/7/partidas/${id}/palpite`, { palpite: 'CASA' }, 'Bearer valid')).status).toBe(400);
    expect((await request('PUT', `/${id}/partidas/1/palpite`, { palpite: 'CASA' }, 'Bearer valid')).status).toBe(400);
    expect(service.buscar).not.toHaveBeenCalled();
    expect(service.salvarPalpite).not.toHaveBeenCalled();
  });

  it.each(['pagina=0', 'pagina=abc', 'pagina=1.5', 'pagina=4294967296', 'limite=0', 'limite=101', 'tipoAcesso=VIP', 'status=RASCUNHO', 'usuarioId=43'])
  ('rejeita query publica invalida: %s', async query => {
    expect((await request('GET', `?${query}`)).status).toBe(400);
    expect(service.listar).not.toHaveBeenCalled();
  });

  it('preserva respostas 404 e 409 do dominio', async () => {
    service.buscar.mockRejectedValueOnce(new NotFoundException('Desafio indisponivel'));
    expect((await request('GET', '/7')).status).toBe(404);
    service.salvarPalpite.mockRejectedValueOnce(new NotFoundException('Partida inexistente'));
    expect((await request('PUT', '/7/partidas/1/palpite', { palpite: 'CASA' }, 'Bearer valid')).status).toBe(404);
    service.salvarPalpite.mockRejectedValueOnce(new ConflictException('Partida fechada'));
    const response = await request('PUT', '/7/partidas/1/palpite', { palpite: 'CASA' }, 'Bearer valid');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ statusCode: 409, message: 'Partida fechada' });
  });
});
