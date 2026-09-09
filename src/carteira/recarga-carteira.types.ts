import { Prisma } from '@prisma/client';

export interface CriarRecargaCarteira {
  carteiraId: number;
  valor: string | Prisma.Decimal;
  provedor: string;
  externalReference?: string;
  idPagamentoExterno?: string;
}

export interface AtualizarPixRecarga {
  idPagamentoExterno?: string;
  pixCopiaCola?: string | null;
  qrCode?: string | null;
  expiracao?: Date | null;
}
