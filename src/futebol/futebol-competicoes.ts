export const FUTEBOL_COMPETICOES = ['BSA', 'CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'PPL', 'DED', 'ELC'] as const;
export type FutebolCodigo = typeof FUTEBOL_COMPETICOES[number];
export function isFutebolCodigo(code: string): code is FutebolCodigo {
  return (FUTEBOL_COMPETICOES as readonly string[]).includes(code);
}
