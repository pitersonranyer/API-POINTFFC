export enum PocPixStatus {
  PROCESSANDO = 'PROCESSANDO', PENDENTE = 'PENDENTE', APROVADO = 'APROVADO',
  CANCELADO = 'CANCELADO', EXPIRADO = 'EXPIRADO', REJEITADO = 'REJEITADO', ERRO = 'ERRO',
  REEMBOLSADO = 'REEMBOLSADO', REEMBOLSADO_PARCIALMENTE = 'REEMBOLSADO_PARCIALMENTE', CONTESTADO = 'CONTESTADO',
}

// Orders API statuses, not the legacy Payments API vocabulary.
export function mapOrderStatus(status?: string, detail?: string): PocPixStatus {
  switch (status) {
    case 'created': case 'processing': return PocPixStatus.PROCESSANDO;
    case 'action_required': return PocPixStatus.PENDENTE;
    case 'processed': return detail === 'accredited' ? PocPixStatus.APROVADO
      : detail === 'partially_refunded' ? PocPixStatus.REEMBOLSADO_PARCIALMENTE : PocPixStatus.ERRO;
    case 'canceled': return PocPixStatus.CANCELADO;
    case 'expired': return PocPixStatus.EXPIRADO;
    case 'failed': return detail === 'processing_error' ? PocPixStatus.ERRO : PocPixStatus.REJEITADO;
    case 'refunded': return PocPixStatus.REEMBOLSADO;
    case 'charged_back': return PocPixStatus.CONTESTADO;
    default: return PocPixStatus.ERRO;
  }
}
