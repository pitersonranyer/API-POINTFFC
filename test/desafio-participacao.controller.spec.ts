import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { DesafioParticipacaoController } from '../src/desafios/desafio-participacao.controller';
import { DesafioParticipacaoService } from '../src/desafios/desafio-participacao.service';
import { desafioParticipacaoFixture } from './helpers/desafio-participacao.fixture';

describe('POST /desafios/:id/participar HTTP com servicos reais', () => {
  let app: INestApplication;
  let base: string;
  let f: ReturnType<typeof desafioParticipacaoFixture>;
  const auth = { authenticateJwt: jest.fn() };
  const participar = jest.fn((id: number, usuarioId: number, inscricaoId?: number) => f.service.participar(id, usuarioId, inscricaoId));
  const request = (body?: unknown, authorization: string | null = 'Bearer valid', id = '7') => fetch(`${base}/desafios/${id}/participar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization === null ? {} : { Authorization: authorization }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DesafioParticipacaoController], providers: [JwtAuthGuard,
      { provide: AuthService, useValue: auth }, { provide: DesafioParticipacaoService, useValue: { participar } },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    f = desafioParticipacaoFixture();
    const agora = Date.now();
    Object.assign(f.desafio, { publicadoEm: new Date(agora - 60000), inicioInscricao: new Date(agora - 60000),
      fimInscricao: new Date(agora + 3600000), dataInicio: new Date(agora + 7200000), dataFim: new Date(agora + 86400000) });
    f.state.partidas.forEach(p => { p.dataInicio = new Date(agora + 7200000); });
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 42, status: 'ATIVO' });
  });

  it('PAGO retorna inscricao e valor cobrado com 200; repetir nao cobra de novo', async () => {
    const primeira = await request();
    expect(primeira.status).toBe(200);
    const original = await primeira.json();
    expect(original).toEqual({ tipoAcesso: 'PAGO', valorCobrado: '2.00', inscricao: {
      id: expect.any(Number), desafioId: 7, status: 'ATIVA', numero: 1, nome: 'Palpite 1', valorInscricao: '2.00', dataInscricao: expect.any(String),
    } });
    const segunda = await request({});
    expect(segunda.status).toBe(200); expect(await segunda.json()).toEqual(original);
    expect(participar).toHaveBeenCalledWith(7, 42, undefined);
    expect(f.state.movimentos).toHaveLength(1); expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toHaveLength(1);
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('FREE confirma com zero sem carteira', async () => {
    f.desafio.tipoAcesso = 'FREE'; f.desafio.valorInscricao = new Prisma.Decimal(0); f.state.carteiras = [];
    const response = await request({});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tipoAcesso: 'FREE', valorCobrado: '0.00', inscricao: { status: 'ATIVA' } });
    expect(f.state.movimentos).toEqual([]); expect(f.state.carteiras).toEqual([]);
  });

  it('confirma a cartela indicada e rejeita inscricao de outro usuario', async () => {
    expect((await request({ inscricaoId: 7043 })).status).toBe(404);
    const response = await request({ inscricaoId: 7042 });
    expect(response.status).toBe(200);
    expect(participar).toHaveBeenLastCalledWith(7, 42, 7042);
    expect((await response.json()).inscricao).toMatchObject({ id: 7042, numero: 1, status: 'ATIVA' });
  });

  it.each([null, 0, -1, 1.5, '7042', 4294967296])('rejeita inscricaoId invalido: %j', async inscricaoId => {
    expect((await request({ inscricaoId })).status).toBe(400);
    expect(participar).not.toHaveBeenCalled();
  });

  it('retorna codigo e valores de saldo insuficiente para o frontend sem iniciar PIX', async () => {
    f.state.carteiras[0].saldoDisponivel = new Prisma.Decimal('0.50');
    const response = await request({});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ statusCode: 409, code: 'SALDO_INSUFICIENTE',
      message: 'Adicione saldo a carteira para participar do Desafio.', saldoDisponivel: '0.50',
      valorNecessario: '2.00', valorFaltante: '1.50', moeda: 'BRL' });
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]); expect(f.state.movimentos).toEqual([]);
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('informa partidas sem palpites em erro de negocio', async () => {
    f.state.palpites = [];
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PALPITES_INCOMPLETOS', partidaIds: [1, 2] });
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]); expect(f.state.movimentos).toEqual([]);
  });

  it('exige JWT e rejeita token malformado ou expirado', async () => {
    expect((await request({}, null)).status).toBe(401);
    expect((await request({}, 'invalid')).status).toBe(401);
    auth.authenticateJwt.mockRejectedValueOnce(new UnauthorizedException('Token expirado'));
    expect((await request({}, 'Bearer expired')).status).toBe(401);
    expect(participar).not.toHaveBeenCalled();
  });

  it('recusa bloqueado no guard e inativo na validacao transacional', async () => {
    auth.authenticateJwt.mockResolvedValueOnce({ idUsuario: 42, status: 'BLOQUEADO' });
    expect((await request()).status).toBe(403);
    expect(participar).not.toHaveBeenCalled();
    f.state.usuarios[0].status = 'INATIVO';
    expect((await request()).status).toBe(403);
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]);
  });

  it.each(['usuarioId', 'valorInscricao', 'tipoAcesso', 'palpite', 'palpites', 'carteiraId', 'movimentacaoDebitoId', 'status'])
  ('rejeita controle enviado no body: %s', async campo => {
    expect((await request({ [campo]: 42 })).status).toBe(400);
    expect(participar).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', 'abc', '4294967296'])('rejeita ID invalido: %s', async id => {
    expect((await request({}, 'Bearer valid', id)).status).toBe(400);
    expect(participar).not.toHaveBeenCalled();
  });

  it('404 para Desafio inexistente e 409 para periodo encerrado', async () => {
    expect((await request({}, 'Bearer valid', '999')).status).toBe(404);
    f.desafio.fimInscricao = new Date(Date.now() - 1);
    const response = await request();
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'FORA_JANELA_INSCRICAO' });
  });
});
