export const FUTEBOL_COMPETICOES = ['BSA', 'CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'PPL', 'DED', 'ELC'] as const;
export type FutebolCodigo = typeof FUTEBOL_COMPETICOES[number];
// O filtro agregado /matches?competitions= exige IDs numericos, nao os codigos das rotas.
export const FUTEBOL_COMPETICAO_IDS: Record<FutebolCodigo, number> = {
  BSA: 2013, CL: 2001, PL: 2021, PD: 2014, SA: 2019,
  BL1: 2002, FL1: 2015, PPL: 2017, DED: 2003, ELC: 2016,
};
export function isFutebolCodigo(code: string): code is FutebolCodigo {
  return (FUTEBOL_COMPETICOES as readonly string[]).includes(code);
}
