import { mapRecargaOrderStatus } from '../src/carteira/mercado-pago-recarga-status';

describe('Mapeamento oficial de Order para recarga', () => {
  it.each([
    ['action_required', undefined, 'PENDENTE'], ['processing', undefined, 'PROCESSANDO'],
    ['created', undefined, 'PROCESSANDO'], ['processed', 'accredited', 'APROVADA'],
    ['approved', undefined, 'APROVADA'], ['rejected', undefined, 'REJEITADA'],
    ['canceled', undefined, 'CANCELADA'], ['cancelled', undefined, 'CANCELADA'],
    ['expired', undefined, 'EXPIRADA'], ['refunded', undefined, 'REEMBOLSADA'],
    ['processed', undefined, null], ['processed', 'pending', null],
    ['processed', 'partially_refunded', null], ['unexpected', 'accredited', null],
  ])('%s/%s -> %s', (status, detail, result) => {
    expect(mapRecargaOrderStatus(status, detail)).toBe(result);
  });
});
