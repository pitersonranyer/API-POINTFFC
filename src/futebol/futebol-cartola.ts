// Conferido em /clubes e /atletas/mercado da integração Cartola em 2026-09-11.
// Resolução explícita por ID; nenhum nome/sigla participa da associação.
export const CARTOLA_CLUBES_BSA: Readonly<Record<number, number>> = Object.freeze({
  "1765": 266,
  "1766": 282,
  "1767": 284,
  "1768": 293,
  "1769": 275,
  "1770": 263,
  "1771": 283,
  "1772": 315,
  "1776": 276,
  "1777": 265,
  "1779": 264,
  "1780": 267,
  "1782": 287,
  "1783": 262,
  "4241": 294,
  "4286": 280,
  "4287": 364,
  "4364": 2305,
  "6684": 285,
  "6685": 277
});

// undefined em updates preserva qualquer vínculo já persistido.
// Na criação, o chamador usa null quando não há enriquecimento.
export function vinculoCartola(codigo: string, externalId: number): { cartolaClubeId?: number } {
  if (codigo !== 'BSA') return {};
  const cartolaClubeId = CARTOLA_CLUBES_BSA[externalId];
  return cartolaClubeId === undefined ? {} : { cartolaClubeId };
}
