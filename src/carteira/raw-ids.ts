import { BadRequestException } from '@nestjs/common';

// SQL raw não aplica o mapeamento de Int do model Prisma a INTEGER UNSIGNED.
export type RawIds<T, K extends keyof T> = Omit<T, K> & { [P in K]: number | bigint };

export function normalizarIdUnsignedRaw(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BadRequestException('ID inválido');
    value = Number(value);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 4294967295) {
    throw new BadRequestException('ID inválido');
  }
  return value;
}

// Normaliza somente os campos declarados; preserva Decimal, datas e demais valores.
export function normalizarIdsRaw<T extends object, K extends keyof T>(row: T, fields: readonly K[]): Omit<T, K> & Record<K, number> {
  const normalized = { ...row };
  for (const field of fields) Object.assign(normalized, { [field]: normalizarIdUnsignedRaw(row[field]) });
  return normalized as Omit<T, K> & Record<K, number>;
}
