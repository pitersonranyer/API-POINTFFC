// IDs conferidos nos 20 clubes BSA persistidos. Não depende do texto do provedor.
export const NOMES_CLUBES_BSA: Readonly<Record<number, string>> = Object.freeze({
  "1765": "Fluminense",
  "1766": "Atlético-MG",
  "1767": "Grêmio",
  "1768": "Athletico-PR",
  "1769": "Palmeiras",
  "1770": "Botafogo",
  "1771": "Cruzeiro",
  "1772": "Chapecoense",
  "1776": "São Paulo",
  "1777": "Bahia",
  "1779": "Corinthians",
  "1780": "Vasco",
  "1782": "Vitória",
  "1783": "Flamengo",
  "4241": "Coritiba",
  "4286": "Bragantino",
  "4287": "Remo",
  "4364": "Mirassol",
  "6684": "Internacional",
  "6685": "Santos"
});
export function nomesClube(externalId: number, original: string, curto: string | null) {
  const nome = NOMES_CLUBES_BSA[externalId];
  return { nomeOriginal: original, nome: nome ?? original, nomeCurto: nome ?? curto ?? original };
}
