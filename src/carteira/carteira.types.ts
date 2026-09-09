import { MovimentacaoCarteiraOrigem, Prisma } from '@prisma/client';

export interface OperacaoCarteira {
  usuarioId: number;
  valor: string | Prisma.Decimal;
  origem: MovimentacaoCarteiraOrigem;
  referenciaId?: string;
  descricao?: string;
}
