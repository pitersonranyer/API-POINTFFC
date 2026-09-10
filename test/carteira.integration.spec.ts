import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CarteiraService } from '../src/carteira/carteira.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Usar apenas banco de teste com as migrations aplicadas. Nunca usa DATABASE_URL implicitamente.
const databaseUrl = process.env.CARTEIRA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('Carteira - transações reais MySQL', () => {
  const prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  const service = new CarteiraService(prisma as PrismaService);
  let usuarioId: number;
  beforeAll(() => prisma.$connect());
  beforeEach(async () => {
    const usuario = await prisma.usuario.create({ data: { email: `carteira-test-${randomUUID()}@example.invalid` } });
    usuarioId = usuario.idUsuario;
  });
  afterEach(async () => {
    // Limpeza restrita ao usuário exclusivo criado pelo teste, em ordem das FKs.
    await prisma.$transaction(async (tx) => {
      await tx.movimentacaoCarteira.deleteMany({ where: { carteira: { usuarioId } } });
      await tx.carteira.deleteMany({ where: { usuarioId } });
      await tx.usuario.delete({ where: { idUsuario: usuarioId } });
    });
  });
  afterAll(() => prisma.$disconnect());
  const input = (valor: string) => ({ usuarioId, valor, origem: 'AJUSTE' as const });

  it('pagina extrato por data e desempata por ID sem incluir outra carteira', async () => {
    const outro = await prisma.usuario.create({ data: { email: `carteira-test-${randomUUID()}@example.invalid` } });
    try {
      await service.creditar({ usuarioId: outro.idUsuario, valor: '99', origem: 'AJUSTE' });
      const a = await service.creditar(input('1'));
      const b = await service.creditar(input('2'));
      const c = await service.creditar(input('3'));
      await prisma.movimentacaoCarteira.updateMany({ where: { id: { in: [a.id, c.id] } }, data: { criadoEm: new Date('2026-01-01T00:00:00Z') } });
      await prisma.movimentacaoCarteira.update({ where: { id: b.id }, data: { criadoEm: new Date('2026-01-02T00:00:00Z') } });
      const primeira = await service.consultarExtratoPaginado(usuarioId, 1, 2);
      const segunda = await service.consultarExtratoPaginado(usuarioId, 2, 2);
      expect(primeira.items.map((item) => item.id)).toEqual([b.id, c.id]);
      expect(segunda.items.map((item) => item.id)).toEqual([a.id]);
      expect(primeira).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(segunda).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    } finally {
      await prisma.movimentacaoCarteira.deleteMany({ where: { carteira: { usuarioId: outro.idUsuario } } });
      await prisma.carteira.deleteMany({ where: { usuarioId: outro.idUsuario } });
      await prisma.usuario.delete({ where: { idUsuario: outro.idUsuario } });
    }
  });

  it('extrato vazio cria carteira sob demanda sem movimentacao', async () => {
    expect(await service.consultarExtratoPaginado(usuarioId, 1, 20)).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    expect(await prisma.carteira.count({ where: { usuarioId } })).toBe(1);
    expect(await prisma.movimentacaoCarteira.count({ where: { carteira: { usuarioId } } })).toBe(0);
  });

  it('cria uma única carteira sob demanda mesmo com chamadas concorrentes', async () => {
    expect(await prisma.carteira.count({ where: { usuarioId } })).toBe(0);
    const [a, b] = await Promise.all([service.obterOuCriar(usuarioId), service.obterOuCriar(usuarioId)]);
    expect(a.id).toBe(b.id);
    expect(a.saldoDisponivel.toString()).toBe('0');
    expect(a.saldoBloqueado.toString()).toBe('0');
    expect(a.status).toBe('ATIVA');
    expect(await prisma.carteira.count({ where: { usuarioId } })).toBe(1);
    await expect(prisma.carteira.create({ data: { usuarioId } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('persiste crédito, débito e extrato consistente', async () => {
    await service.creditar(input('10.10'));
    await service.debitar(input('0.10'));
    const carteira = await service.obterOuCriar(usuarioId);
    expect(carteira.saldoDisponivel.toString()).toBe('10');
    const extrato = await service.consultarExtrato(usuarioId);
    expect(extrato.map((m) => [m.tipo, m.saldoAnterior.toString(), m.saldoPosterior.toString()])).toEqual([
      ['CREDITO', '0', '10.1'], ['DEBITO', '10.1', '10'],
    ]);
    await expect(prisma.usuario.delete({ where: { idUsuario: usuarioId } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.carteira.delete({ where: { id: carteira.id } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('reverte saldo e movimentação se a transação falhar após inserir o registro', async () => {
    await service.creditar(input('10'));
    const failingService = new CarteiraService({
      $transaction: (callback: (tx: unknown) => Promise<unknown>) => prisma.$transaction(async (tx) => {
        await callback(tx);
        throw new Error('Falha antes do commit');
      }),
    } as unknown as PrismaService);
    await expect(failingService.debitar(input('3'))).rejects.toThrow('Falha antes do commit');
    expect((await service.obterOuCriar(usuarioId)).saldoDisponivel.toString()).toBe('10');
    expect(await service.consultarExtrato(usuarioId)).toHaveLength(1);
  });

  it('reverte atualização do saldo se a inserção da movimentação falhar', async () => {
    await service.creditar(input('10'));
    await expect(service.debitar({ ...input('3'), referenciaId: 'x'.repeat(256) })).rejects.toThrow();
    expect((await service.obterOuCriar(usuarioId)).saldoDisponivel.toString()).toBe('10');
    expect(await service.consultarExtrato(usuarioId)).toHaveLength(1);
  });

  it('dois débitos concorrentes não consomem o mesmo saldo', async () => {
    await service.creditar(input('10'));
    const results = await Promise.allSettled([service.debitar(input('7')), service.debitar(input('7'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toBe('Saldo insuficiente');
    expect((await service.obterOuCriar(usuarioId)).saldoDisponivel.toString()).toBe('3');
    expect(await service.consultarExtrato(usuarioId)).toHaveLength(2);
  });

  it('carteira bloqueada não aceita crédito nem débito', async () => {
    await service.creditar(input('10'));
    await prisma.carteira.update({ where: { usuarioId }, data: { status: 'BLOQUEADA' } });
    await expect(service.creditar(input('1'))).rejects.toThrow('Carteira bloqueada');
    await expect(service.debitar(input('1'))).rejects.toThrow('Carteira bloqueada');
    expect((await service.obterOuCriar(usuarioId)).saldoDisponivel.toString()).toBe('10');
    expect(await service.consultarExtrato(usuarioId)).toHaveLength(1);
  });
});
