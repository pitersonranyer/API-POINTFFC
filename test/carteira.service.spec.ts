import { Prisma } from '@prisma/client';
import { CarteiraService } from '../src/carteira/carteira.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecargaCarteiraService } from '../src/carteira/recarga-carteira.service';

describe('CarteiraService', () => {
  const decimal = (value: string) => new Prisma.Decimal(value);
  let service: CarteiraService;
  let tx: any;
  let prisma: any;
  let carteira: any;
  const input = { usuarioId: 1, valor: '2.50', origem: 'AJUSTE' as const };

  beforeEach(() => {
    carteira = { id: 10, usuarioId: 1, saldoDisponivel: decimal('10'), saldoBloqueado: decimal('0'), status: 'ATIVA' };
    tx = {
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id_usuario: 1 }]).mockImplementation(() => Promise.resolve([carteira])),
      carteira: { upsert: jest.fn().mockResolvedValue(carteira), update: jest.fn().mockResolvedValue(carteira) },
      movimentacaoCarteira: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    };
    prisma = { $transaction: jest.fn((callback) => callback(tx)), movimentacaoCarteira: { findMany: jest.fn().mockResolvedValue([]) } };
    service = new CarteiraService(prisma as PrismaService);
  });

  it('cria sob demanda usando usuarioId único e defaults do banco', async () => {
    expect(await service.obterOuCriar(1)).toEqual(carteira);
    expect(tx.carteira.upsert).toHaveBeenCalledWith({ where: { usuarioId: 1 }, create: { usuarioId: 1 }, update: {} });
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.every(([sql]: [TemplateStringsArray]) => sql.join('').includes('FOR UPDATE'))).toBe(true);
  });

  it.each([['creditar', 'CREDITO', '12.5'], ['debitar', 'DEBITO', '7.5']] as const)('%s registra saldo anterior e posterior', async (method, tipo, saldo) => {
    const movimento = await service[method](input);
    expect(movimento.tipo).toBe(tipo);
    expect(movimento.status).toBe('CONFIRMADA');
    expect(movimento.valor.toString()).toBe('2.5');
    expect(movimento.saldoAnterior.toString()).toBe('10');
    expect(movimento.saldoPosterior.toString()).toBe(saldo);
    expect(tx.carteira.update).toHaveBeenCalledWith({ where: { id: 10 }, data: { saldoDisponivel: decimal(saldo) } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejeita saldo insuficiente sem escrita financeira', async () => {
    await expect(service.debitar({ ...input, valor: '10.01' })).rejects.toThrow('Saldo insuficiente');
    expect(tx.carteira.update).not.toHaveBeenCalled();
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
  });

  it.each(['creditar', 'debitar'] as const)('carteira bloqueada impede %s', async (method) => {
    carteira.status = 'BLOQUEADA';
    await expect(service[method](input)).rejects.toThrow('Carteira bloqueada');
    expect(tx.carteira.update).not.toHaveBeenCalled();
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.001', '1.000', 'NaN', 'Infinity', 'abc', '10000000000', new Prisma.Decimal('0.001'), 1.5])('rejeita valor inválido %s', async (valor) => {
    await expect(service.creditar({ ...input, valor: valor as string })).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('calcula centavos exatamente', async () => {
    carteira.saldoDisponivel = decimal('0.10');
    const result = await service.creditar({ ...input, valor: decimal('0.20') });
    expect(result.saldoPosterior.toString()).toBe('0.3');
  });

  it('rejeita estouro de Decimal(12,2)', async () => {
    carteira.saldoDisponivel = decimal('9999999999.99');
    await expect(service.creditar(input)).rejects.toThrow('Saldo fora do limite');
    expect(tx.carteira.update).not.toHaveBeenCalled();
  });

  it.each(['saldoDisponivel', 'saldoBloqueado'])('rejeita %s negativo preexistente', async (campo) => {
    carteira[campo] = decimal('-1');
    await expect(service.creditar(input)).rejects.toThrow('Carteira com saldo inválido');
  });

  it('propaga falha de movimentação para abortar transação', async () => {
    tx.movimentacaoCarteira.create.mockRejectedValue(new Error('Falha ao registrar'));
    await expect(service.creditar(input)).rejects.toThrow('Falha ao registrar');
    expect(tx.carteira.update).toHaveBeenCalledTimes(1);
  });

  it('rejeita usuário inexistente', async () => {
    tx.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(service.obterOuCriar(1)).rejects.toThrow('Usuário não encontrado');
    expect(tx.carteira.upsert).not.toHaveBeenCalled();
  });

  it('consulta extrato da carteira do usuário em ordem estável', async () => {
    await service.consultarExtrato(1);
    expect(prisma.movimentacaoCarteira.findMany).toHaveBeenCalledWith({ where: { carteiraId: 10 }, orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }] });
  });

  it('não permite RECARGA_PIX pelo crédito genérico', async () => {
    await expect(service.creditar({ ...input, origem: 'RECARGA_PIX' })).rejects.toThrow('PIX exige crédito vinculado');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('normaliza carteira raw bigint e permite criar a recarga sem ID inválido', async () => {
    carteira.id = 1n;
    carteira.usuarioId = 1n;
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ id_usuario: 1n }]).mockResolvedValueOnce([carteira]);
    prisma.recargaCarteira = { create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 2, ...data })) };
    const normalizada = await service.obterOuCriar(1);
    expect(normalizada.id).toBe(1);
    expect(normalizada.usuarioId).toBe(1);
    expect(normalizada.saldoDisponivel).toBe(carteira.saldoDisponivel);
    expect(normalizada.saldoBloqueado).toBe(carteira.saldoBloqueado);
    const recarga = await new RecargaCarteiraService(prisma as PrismaService).criar({
      carteiraId: normalizada.id, valor: '10.00', provedor: 'MERCADO_PAGO',
    });
    expect(recarga.carteiraId).toBe(normalizada.id);
  });

  it('crédito comum usa ID normalizado no update e na movimentação', async () => {
    carteira.id = 10n; carteira.usuarioId = 1n;
    await service.creditar(input);
    expect(tx.carteira.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 10 } }));
    expect(tx.movimentacaoCarteira.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ carteiraId: 10 }) }));
  });

  it.each(['id', 'usuarioId'])('rejeita %s raw fora da faixa antes de alterar saldo', async (campo) => {
    carteira[campo] = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(service.creditar(input)).rejects.toThrow('ID inválido');
    expect(tx.carteira.update).not.toHaveBeenCalled();
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
  });
});

describe('CarteiraService - crédito PIX vinculado', () => {
  let service: CarteiraService;
  let tx: any;
  let recarga: any;
  let carteira: any;
  let movimento: any;
  const oficial = { idPagamentoExterno: 'ORD1', externalReference: 'ref', valor: new Prisma.Decimal('7.25'), status: 'APROVADA' as const };
  beforeEach(() => {
    recarga = { id: 3, carteiraId: 2, valor: new Prisma.Decimal('7.25'), provedor: 'MERCADO_PAGO',
      externalReference: 'ref', idPagamentoExterno: 'ORD1', status: 'PENDENTE', aprovadoEm: null };
    carteira = { id: 2, usuarioId: 1, status: 'ATIVA', saldoDisponivel: new Prisma.Decimal('10'), saldoBloqueado: new Prisma.Decimal('0') };
    movimento = null;
    tx = {
      $queryRaw: jest.fn(async (sql: TemplateStringsArray) => sql.join('').includes('RECARGA_CARTEIRA') ? [{ ...recarga }] : [{ ...carteira }]),
      carteira: { update: jest.fn(async ({ data }: any) => Object.assign(carteira, data)) },
      recargaCarteira: { update: jest.fn(async ({ data }: any) => {
        Object.entries(data).forEach(([key, value]) => { if (value !== undefined) recarga[key] = value; }); return { ...recarga };
      }) },
      movimentacaoCarteira: {
        findUnique: jest.fn(async () => movimento),
        create: jest.fn(async ({ data }: any) => { movimento = { id: 4, ...data }; return movimento; }),
      },
    };
    service = new CarteiraService({ $transaction: (callback: any) => callback(tx) } as PrismaService);
  });

  it('crédito vincula recarga, preserva saldos corretos e trava as duas linhas', async () => {
    await service.aplicarRecargaPix(3, oficial);
    expect(movimento).toMatchObject({ recargaId: 3, referenciaId: '3', tipo: 'CREDITO', origem: 'RECARGA_PIX', carteiraId: 2 });
    expect(movimento.saldoAnterior.toString()).toBe('10');
    expect(movimento.saldoPosterior.toString()).toBe('17.25');
    expect(carteira.saldoDisponivel.toString()).toBe('17.25');
    expect(recarga.status).toBe('APROVADA');
    expect(recarga.aprovadoEm).toBeInstanceOf(Date);
    expect(tx.$queryRaw.mock.calls.every(([sql]: [TemplateStringsArray]) => sql.join('').includes('FOR UPDATE'))).toBe(true);
  });

  it('aprovação duplicada não cria outra movimentação nem soma saldo', async () => {
    await service.aplicarRecargaPix(3, oficial);
    await service.aplicarRecargaPix(3, oficial);
    expect(tx.movimentacaoCarteira.create).toHaveBeenCalledTimes(1);
    expect(tx.carteira.update).toHaveBeenCalledTimes(1);
    expect(carteira.saldoDisponivel.toString()).toBe('17.25');
  });

  it.each(['PENDENTE', 'PROCESSANDO', 'REJEITADA', 'EXPIRADA', 'CANCELADA', 'REEMBOLSADA', null] as const)('status %s não credita', async (status) => {
    await service.aplicarRecargaPix(3, { ...oficial, status });
    expect(tx.carteira.update).not.toHaveBeenCalled();
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
  });

  it('eventos atrasados não rebaixam aprovação e reembolso não estorna nem permite novo crédito', async () => {
    await service.aplicarRecargaPix(3, oficial);
    await service.aplicarRecargaPix(3, { ...oficial, status: 'PENDENTE' });
    expect(recarga.status).toBe('APROVADA');
    await service.aplicarRecargaPix(3, { ...oficial, status: 'REEMBOLSADA' });
    await service.aplicarRecargaPix(3, oficial);
    expect(recarga.status).toBe('REEMBOLSADA');
    expect(tx.movimentacaoCarteira.create).toHaveBeenCalledTimes(1);
    expect(carteira.saldoDisponivel.toString()).toBe('17.25');
  });

  it('não credita aprovação atrasada de recarga já reembolsada', async () => {
    recarga.status = 'REEMBOLSADA';
    await service.aplicarRecargaPix(3, oficial);
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
  });

  it('carteira bloqueada impede crédito e deixa erro recuperável', async () => {
    carteira.status = 'BLOQUEADA';
    await expect(service.aplicarRecargaPix(3, oficial)).rejects.toThrow('Crédito pendente');
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
    expect(tx.recargaCarteira.update).not.toHaveBeenCalled();
  });

  it('falha ao registrar movimentação aborta antes da aprovação', async () => {
    tx.movimentacaoCarteira.create.mockRejectedValue(new Error('insert falhou'));
    await expect(service.aplicarRecargaPix(3, oficial)).rejects.toThrow('insert falhou');
    expect(tx.recargaCarteira.update).not.toHaveBeenCalled();
  });

  it('revalida o vínculo oficial dentro do lock', async () => {
    recarga.externalReference = 'alterada';
    await expect(service.aplicarRecargaPix(3, oficial)).rejects.toThrow('Order incompatível');
    expect(tx.carteira.update).not.toHaveBeenCalled();
  });

  it('normaliza IDs raw de recarga e carteira no crédito PIX', async () => {
    recarga.id = 3n; recarga.carteiraId = 2n;
    carteira.id = 2n; carteira.usuarioId = 1n;
    await service.aplicarRecargaPix(3, oficial);
    expect(tx.$queryRaw.mock.calls[1][1]).toBe(2);
    expect(tx.carteira.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2 } }));
    expect(movimento).toMatchObject({ carteiraId: 2, recargaId: 3, referenciaId: '3' });
    expect(movimento.valor).toBeInstanceOf(Prisma.Decimal);
    expect(movimento.saldoAnterior.toString()).toBe('10');
    expect(movimento.saldoPosterior.toString()).toBe('17.25');
  });

  it.each(['id', 'carteiraId'])('rejeita %s raw da recarga fora da faixa antes de creditar', async (campo) => {
    recarga[campo] = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(service.aplicarRecargaPix(3, oficial)).rejects.toThrow('ID inválido');
    expect(tx.carteira.update).not.toHaveBeenCalled();
    expect(tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
    expect(tx.recargaCarteira.update).not.toHaveBeenCalled();
  });
});
