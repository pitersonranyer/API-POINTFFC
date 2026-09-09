import { RecargaCarteiraStatus } from '@prisma/client';

// null preserva o status local e nunca autoriza crédito de status desconhecido.
export function mapRecargaOrderStatus(status?: string, detail?: string): RecargaCarteiraStatus | null {
  switch (status) {
    case 'action_required': return 'PENDENTE';
    case 'created': case 'processing': return 'PROCESSANDO';
    case 'processed': return detail === 'accredited' ? 'APROVADA' : null;
    case 'approved': return 'APROVADA';
    case 'rejected': return 'REJEITADA';
    case 'canceled': case 'cancelled': return 'CANCELADA';
    case 'expired': return 'EXPIRADA';
    case 'refunded': return 'REEMBOLSADA';
    default: return null;
  }
}
