import { Prisma } from '@prisma/client';
import { normalizarIdsRaw, normalizarIdUnsignedRaw } from '../src/carteira/raw-ids';

describe('IDs INTEGER UNSIGNED retornados por SQL raw', () => {
  it.each([1, 1n, 4294967295, 4294967295n])('aceita ID válido %s como number', (id) => {
    expect(normalizarIdUnsignedRaw(id)).toBe(Number(id));
  });

  it.each([0, 0n, -1, -1n, 1.5, NaN, Infinity, '1', null, undefined,
    4294967296, 4294967296n, Number.MAX_SAFE_INTEGER,
    BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER) + 1n])('rejeita ID inválido %s', (id) => {
    expect(() => normalizarIdUnsignedRaw(id)).toThrow('ID inválido');
  });

  it('normaliza id/usuarioId/carteiraId/recargaId sem converter Decimal nem mutar a linha', () => {
    const raw = { id: 1n, usuarioId: 2n, carteiraId: 3n, recargaId: 4n,
      valor: new Prisma.Decimal('10.25'), saldoDisponivel: new Prisma.Decimal('20.10'),
      saldoBloqueado: new Prisma.Decimal('0'), criadoEm: new Date(), referenciaId: '4' };
    const result = normalizarIdsRaw(raw, ['id', 'usuarioId', 'carteiraId', 'recargaId']);
    expect(result).toMatchObject({ id: 1, usuarioId: 2, carteiraId: 3, recargaId: 4, referenciaId: '4' });
    expect(result.valor).toBe(raw.valor);
    expect(result.saldoDisponivel).toBe(raw.saldoDisponivel);
    expect(result.saldoBloqueado).toBe(raw.saldoBloqueado);
    expect(result.criadoEm).toBe(raw.criadoEm);
    expect(raw.id).toBe(1n);
  });
});
