import { BadGatewayException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export function classifyAthlete(price: Prisma.Decimal, position: number) {
  if (!price.isFinite() || price.isNegative() || price.decimalPlaces() > 2 || price.greaterThan('9999999999.99')) {
    throw new BadGatewayException('Preco Cartola invalido');
  }
  if (position === 6) return { categoriaId: null, pointcoins: 10 };
  if (price.lessThan(6)) return { categoriaId: 1, pointcoins: 10 };
  if (price.lessThan(10)) return { categoriaId: 2, pointcoins: 20 };
  return { categoriaId: 3, pointcoins: 30 };
}

export interface SnapshotMatch {
  partidaIdExterno: number;
  clubeMandanteId: number;
  clubeVisitanteId: number;
  inicioPrevisto: string;
}
export interface CatalogReferences {
  clubes: Record<string, unknown>;
  posicoes: Record<string, unknown>;
  partidas: SnapshotMatch[];
}
