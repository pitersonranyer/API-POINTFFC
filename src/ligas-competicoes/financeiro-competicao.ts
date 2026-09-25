import { ConflictException } from '@nestjs/common';
import { CompeticaoTipoTaxaPlataforma, Prisma } from '@prisma/client';

// Mesma precisao e arredondamento do financeiro, sem alterar o Decimal global.
export const DecimalFinanceiro = Prisma.Decimal.clone({ precision: 40, rounding: Prisma.Decimal.ROUND_HALF_UP });
export const centavos = (valor: Prisma.Decimal) => valor.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export function calcularPremiacaoEmDisputa(
  competicao: { id: number; tipoAcesso: string; valorInscricao: Prisma.Decimal;
    tipoTaxaPlataforma: CompeticaoTipoTaxaPlataforma | null; valorTaxaPlataforma: Prisma.Decimal | null },
  quantidade: number,
  premiosFixos: { valor: Prisma.Decimal | null; posicaoInicio: number; posicaoFim: number }[],
): string | null {
  if (competicao.tipoAcesso === 'PAGO') {
    const bruto = new DecimalFinanceiro(competicao.valorInscricao).mul(quantidade);
    return calcularBasePremiacao(competicao.id, bruto, quantidade,
      competicao.tipoTaxaPlataforma, competicao.valorTaxaPlataforma).basePremiacao.toFixed(2);
  }
  const total = premiosFixos.reduce((soma, premio) => premio.valor?.gt(0) && premio.posicaoFim >= premio.posicaoInicio
    ? soma.plus(new DecimalFinanceiro(premio.valor).mul(premio.posicaoFim - premio.posicaoInicio + 1)) : soma,
  new DecimalFinanceiro(0));
  return total.gt(0) ? total.toFixed(2) : null;
}

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
