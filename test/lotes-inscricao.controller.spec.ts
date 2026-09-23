import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { LotesInscricaoController } from '../src/ligas-competicoes/lotes-inscricao.controller';
import { LotesInscricaoService } from '../src/ligas-competicoes/lotes-inscricao.service';
import { lotesFixture } from './helpers/lotes-inscricao.fixture';
import { Prisma } from '@prisma/client';

describe('POST /competicoes/:id/inscricoes/lote', () => {
  let app: INestApplication;
  let base: string;
  let f: ReturnType<typeof lotesFixture>;
  const auth = { authenticateJwt: jest.fn() };
  const service = { criar: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [LotesInscricaoController], providers: [
      JwtAuthGuard, { provide: AuthService, useValue: auth }, { provide: LotesInscricaoService, useValue: service },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  beforeEach(() => {
    jest.clearAllMocks(); f = lotesFixture();
    auth.authenticateJwt.mockResolvedValue({ idUsuario: 10, status: 'ATIVO' });
    service.criar.mockImplementation((...args: Parameters<LotesInscricaoService['criar']>) => f.service.criar(...args));
  });
  afterAll(() => app.close());
  const dto = { timesCartolaIds: [123, 456], valorUnitarioEsperado: '10.00' };
  const post = (body: unknown = dto, key: string | null = 'chave-lote-http-1234', token = true, id = '1') =>
    fetch(`${base}/competicoes/${id}/inscricoes/lote`, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer valid' } : {}),
      ...(key === null ? {} : { 'Idempotency-Key': key }),
    }, body: JSON.stringify(body) });

  it('exige JWT e usa apenas o usuario autenticado', async () => {
    expect((await post(dto, null, false)).status).toBe(401);
    expect(service.criar).not.toHaveBeenCalled();
    expect((await post()).status).toBe(201);
    expect(service.criar).toHaveBeenCalledWith(1, 10, dto, 'chave-lote-http-1234');
  });

  it('retorna contrato monetario em strings e replay com mesmo HTTP e corpo', async () => {
    const a = await post(); const first = await a.json();
    const b = await post();
    expect(a.status).toBe(201); expect(b.status).toBe(201); expect(await b.json()).toEqual(first);
    expect(first).toMatchObject({ valorUnitario: '10.00', valorTotal: '20.00', moeda: 'BRL', saldoDisponivelAposOperacao: '80.00' });
    expect(f.state.movimentos).toHaveLength(1);
  });

  it.each([null, '', 'curta', 'x'.repeat(129)])('rejeita Idempotency-Key invalida: %s', async key => {
    expect((await post(dto, key)).status).toBe(400); expect(f.state.lotes).toEqual([]);
  });

  it.each([
    {}, { timesCartolaIds: [] }, { timesCartolaIds: [123, 123] }, { ...dto, valorUnitarioEsperado: null },
    { ...dto, usuarioId: 99 }, { ...dto, valorTotal: '1.00' }, { ...dto, valorUnitarioEsperado: '10.001' },
    { ...dto, valorUnitarioEsperado: 10 }, { timesCartolaIds: Array.from({ length: 51 }, (_, i) => i + 1) },
  ])('rejeita corpo invalido %j', async body => {
    expect((await post(body)).status).toBe(400); expect(service.criar).not.toHaveBeenCalled();
  });

  it('retorna 409 estruturado para saldo insuficiente', async () => {
    f.state.carteira.saldoDisponivel = new Prisma.Decimal(5);
    const response = await post(); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SALDO_INSUFICIENTE', saldoDisponivel: '5.00',
      valorNecessario: '20.00', valorFaltante: '15.00', moeda: 'BRL' });
  });

  it('retorna 409 estruturado para preco alterado e reutilizacao de chave', async () => {
    const preco = await post({ ...dto, valorUnitarioEsperado: '9.00' });
    expect(preco.status).toBe(409); expect(await preco.json()).toMatchObject({ code: 'PRECO_INSCRICAO_ALTERADO',
      valorEsperado: '9.00', valorAtual: '10.00', quantidade: 2, valorTotalAtual: '20.00' });
    expect((await post()).status).toBe(201);
    const repetida = await post({ ...dto, timesCartolaIds: [123] });
    expect(repetida.status).toBe(409); expect(await repetida.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUTILIZADA' });
  });

  it('FREE usa o mesmo endpoint com valores zero e campos financeiros nulos', async () => {
    Object.assign(f.competicao, { tipoAcesso: 'FREE', valorInscricao: new Prisma.Decimal(0) });
    const response = await post({ ...dto, valorUnitarioEsperado: '0.00' });
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ tipoAcesso: 'FREE',
      valorUnitario: '0.00', valorTotal: '0.00', movimentacaoDebitoId: null, saldoDisponivelAposOperacao: null });
  });

  it.each(['0', 'abc', '1.5'])('rejeita competicao invalida %s', async id => {
    expect((await post(dto, 'chave-lote-http-1234', true, id)).status).toBe(400);
    expect(service.criar).not.toHaveBeenCalled();
  });
});
