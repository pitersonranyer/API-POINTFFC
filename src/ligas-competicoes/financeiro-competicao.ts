import { ConflictException } from '@nestjs/common';
import { CompeticaoTipoTaxaPlataforma, Prisma } from '@prisma/client';

// Mesma precisao e arredondamento do financeiro, sem alterar o Decimal global.
export const DecimalFinanceiro = Prisma.Decimal.clone({ precision: 40, rounding: Prisma.Decimal.ROUND_HALF_UP });
export const centavos = (valor: Prisma.Decimal) => valor.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export function calcularBasePremiacao(
  competicaoId: number,
  valorBruto: Prisma.Decimal,
  quantidade: number,
  tipo: CompeticaoTipoTaxaPlataforma | null,
  taxa: Prisma.Decimal | null,
) {
  if ((tipo === null) !== (taxa === null) || taxa?.lt(0) || (tipo === 'PERCENTUAL' && taxa?.gt(100))) {
    throw new ConflictException(`Taxa da plataforma invalida na competicao ${competicaoId}.`);
  }
  const receitaPoint = centavos(tipo === 'PERCENTUAL'
    ? valorBruto.mul(taxa!).div(100)
    : tipo === 'VALOR_FIXO' ? new DecimalFinanceiro(taxa!).mul(quantidade) : new DecimalFinanceiro(0));
  return { receitaPoint, basePremiacao: valorBruto.minus(receitaPoint) };
}
