import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { CarteiraService } from '../src/carteira/carteira.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Banco de teste dedicado, com migrations ate 0018 aplicadas pelo operador.
// Nunca usa DATABASE_URL implicitamente nem aplica migrations automaticamente.
const databaseUrl = process.env.CARTEIRA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('LoteInscricao - integridade MySQL', () => {
  const prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  const carteiras = new CarteiraService(prisma as PrismaService);
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  async function fixture(tx: Prisma.TransactionClient) {
    const token = randomUUID();
    const usuario = await tx.usuario.create({ data: { email: `lote-${token}@example.invalid` } });
    const vinculo = await tx.ligaModalidade.create({ data: {
      liga: { create: { nome: 'Teste lote', slug: `lote-${token}`, tipo: 'OFICIAL' } },
      modalidade: { create: { nome: 'Teste lote', codigo: `lote-${token}` } },
    } });
    const competicao = await tx.competicaoLiga.create({ data: {
      ligaModalidadeId: vinculo.id, nome: 'Teste lote', slug: `lote-${token}`,
    } });
    const lote = {
      usuarioId: usuario.idUsuario, competicaoLigaId: competicao.id,
      chaveIdempotenciaHash: 'a'.repeat(64), requestHash: 'b'.repeat(64),
      tipoAcesso: 'FREE' as const, quantidade: 1, valorUnitario: '0', valorTotal: '0',
    };
    return { usuario, competicao, lote };
  }

  // Cada cenario reverte exclusivamente seus proprios registros, mesmo se uma assercao falhar.
  async function isolated(run: (tx: Prisma.TransactionClient) => Promise<void>) {
    const rollback = new Error('Rollback de fixture');
    try {
      await prisma.$transaction(async tx => { await run(tx); throw rollback; }, { timeout: 20000 });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  it('aceita historico sem lote e preserva snapshots ao vincular lote', () => isolated(async tx => {
    const { lote } = await fixture(tx);
    const inscricao = await tx.inscricaoTimeCompeticao.create({ data: {
      usuarioId: lote.usuarioId, competicaoLigaId: lote.competicaoLigaId, timeIdCartola: 123, nomeTime: 'Historico',
    } });
    expect(inscricao.loteInscricaoId).toBeNull();
    const criado = await tx.loteInscricao.create({ data: lote });
    const vinculada = await tx.inscricaoTimeCompeticao.update({ where: { id: inscricao.id }, data: { loteInscricaoId: criado.id } });
    expect(vinculada).toEqual({ ...inscricao, loteInscricaoId: criado.id, atualizadoEm: vinculada.atualizadoEm });
    await expect(tx.loteInscricao.delete({ where: { id: criado.id } })).rejects.toMatchObject({ code: 'P2003' });
  }));

  it('chave e unica por usuario mesmo com requestHash diferente, mas admite outro usuario', () => isolated(async tx => {
    const { lote } = await fixture(tx);
    await tx.loteInscricao.create({ data: lote });
    await expect(tx.loteInscricao.create({ data: lote })).rejects.toMatchObject({ code: 'P2002' });
    await expect(tx.loteInscricao.create({ data: { ...lote, requestHash: 'c'.repeat(64) } })).rejects.toMatchObject({ code: 'P2002' });
    const outro = await tx.usuario.create({ data: { email: `lote-${randomUUID()}@example.invalid` } });
    await tx.loteInscricao.create({ data: { ...lote, usuarioId: outro.idUsuario } });
    expect(await tx.loteInscricao.count({ where: { competicaoLigaId: lote.competicaoLigaId } })).toBe(2);
  }));

  it('nao permite compartilhar movimentacao entre lotes e protege o debito contra exclusao', () => isolated(async tx => {
    const { lote } = await fixture(tx);
    await carteiras.creditarEmTransacao(tx, { usuarioId: lote.usuarioId, valor: '10', origem: 'AJUSTE' });
    const debito = await carteiras.debitarEmTransacao(tx, { usuarioId: lote.usuarioId, valor: '3', origem: 'INSCRICAO' });
    const pago = { ...lote, tipoAcesso: 'PAGO' as const, valorUnitario: '3', valorTotal: '3', movimentacaoDebitoId: debito.id, confirmadoEm: new Date() };
    await tx.loteInscricao.create({ data: pago });
    await expect(tx.loteInscricao.create({ data: { ...pago, chaveIdempotenciaHash: 'c'.repeat(64) } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(tx.movimentacaoCarteira.delete({ where: { id: debito.id } })).rejects.toMatchObject({ code: 'P2003' });
  }));

  it('nao confirma PAGO sem debito e nao aceita total inconsistente', () => isolated(async tx => {
    const { lote } = await fixture(tx);
    const pago = { ...lote, tipoAcesso: 'PAGO' as const, valorUnitario: '3', valorTotal: '3' };
    const criado = await tx.loteInscricao.create({ data: pago });
    await expect(tx.loteInscricao.update({ where: { id: criado.id }, data: { confirmadoEm: new Date() } })).rejects.toThrow();
    await expect(tx.loteInscricao.update({ where: { id: criado.id }, data: { valorTotal: '4' } })).rejects.toThrow();
    expect(await tx.loteInscricao.findUniqueOrThrow({ where: { id: criado.id } })).toMatchObject({ confirmadoEm: null, movimentacaoDebitoId: null });
  }));
});
