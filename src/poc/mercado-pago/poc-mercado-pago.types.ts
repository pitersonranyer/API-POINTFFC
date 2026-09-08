import { Order } from 'mercadopago';
import { PocPixStatus } from './mercado-pago-status';

export type OrderResult = Awaited<ReturnType<Order['get']>>;
export interface PixData { copiaCola?: string; qrCodeBase64?: string; expiracao?: string }
export interface PocPix {
  id: string; idExterno: string; referencia: string; valor: string; status: PocPixStatus;
  pix: PixData; criadoEm: string; atualizadoEm: string; atualizadoNoProvedor?: string;
}
export interface PocPixResponse {
  id: string; idExterno: string; valor: number; status: PocPixStatus; pix: PixData; atualizadoEm: string;
}
