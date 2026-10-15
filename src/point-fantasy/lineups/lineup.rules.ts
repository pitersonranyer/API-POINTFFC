import { BadRequestException } from '@nestjs/common';
import { FantasyCatalogoAtleta } from '@prisma/client';

// Cartola: 1 GK, 2 FB, 3 CB, 4 MF, 5 FW, 6 coach.
export const FORMATION_COUNTS: Record<string, Record<number, number>> = {
  '4-3-3': { 1: 1, 2: 2, 3: 2, 4: 3, 5: 3 },
  '4-4-2': { 1: 1, 2: 2, 3: 2, 4: 4, 5: 2 },
  '3-5-2': { 1: 1, 2: 0, 3: 3, 4: 5, 5: 2 },
  '3-4-3': { 1: 1, 2: 0, 3: 3, 4: 4, 5: 3 },
  '4-5-1': { 1: 1, 2: 2, 3: 2, 4: 5, 5: 1 },
  '5-3-2': { 1: 1, 2: 2, 3: 3, 4: 3, 5: 2 },
  '5-4-1': { 1: 1, 2: 2, 3: 3, 4: 4, 5: 1 },
};
export interface LineupSelection {
  formacao: string;
  titulares: number[];
  tecnico: number | null;
  reservas: number[];
  capitaoAtletaId: number | null;
  reservaMagoAtletaId: number | null;
}
export function selectionIds(s: LineupSelection) {
  return [...s.titulares, ...s.reservas, ...(s.tecnico === null ? [] : [s.tecnico])];
}
export function validateSelection(s: LineupSelection, athletes: FantasyCatalogoAtleta[]) {
  const expected = FORMATION_COUNTS[s.formacao];
  if (!Object.prototype.hasOwnProperty.call(FORMATION_COUNTS, s.formacao)) throw new BadRequestException('Formacao invalida');
  const ids = selectionIds(s);
  if (ids.length !== new Set(ids).size) throw new BadRequestException('Atleta duplicado na escalacao');
  const byId = new Map(athletes.map(a => [a.id, a]));
  if (ids.some(id => !byId.has(id))) throw new BadRequestException('Atleta fora do catalogo ou dos clubes da competicao');
  if (s.capitaoAtletaId !== null && !s.titulares.includes(s.capitaoAtletaId)) throw new BadRequestException('Capitao deve ser titular');
  if (s.reservaMagoAtletaId !== null && !s.reservas.includes(s.reservaMagoAtletaId)) throw new BadRequestException('Reserva do Mago deve estar entre os reservas');
  const starters = s.titulares.map(id => byId.get(id)!);
  const reserves = s.reservas.map(id => byId.get(id)!);
  if (s.tecnico !== null && byId.get(s.tecnico)!.posicaoId !== 6) throw new BadRequestException('Tecnico exige posicao 6');
  if ([...starters, ...reserves].some(a => a.posicaoId < 1 || a.posicaoId > 5 || ![1, 2, 3].includes(a.categoriaId!))) {
    throw new BadRequestException('Titulares e reservas exigem jogadores com categoria congelada valida');
  }
  const count = (list: FantasyCatalogoAtleta[], pos: number) => list.filter(a => a.posicaoId === pos).length;
  const reserveCounts: Record<number, number> = { 1: 1, 2: expected[2] ? 1 : 0, 3: expected[2] ? 1 : 2, 4: 1, 5: 1 };
  const pendencias: string[] = [];
  for (const pos of [1, 2, 3, 4, 5]) {
    if (count(starters, pos) > expected[pos]) throw new BadRequestException(`Excesso de titulares na posicao ${pos}`);
    if (count(reserves, pos) > reserveCounts[pos]) throw new BadRequestException(`Composicao de reservas invalida na posicao ${pos}`);
    if (count(starters, pos) < expected[pos]) pendencias.push(`Completar titulares da posicao ${pos}`);
    if (count(reserves, pos) < reserveCounts[pos]) pendencias.push(`Completar reservas da posicao ${pos}`);
    const matching = starters.filter(a => a.posicaoId === pos);
    for (const reserve of reserves.filter(a => a.posicaoId === pos)) {
      if (!matching.length) pendencias.push(`Categoria do reserva ${reserve.id} aguarda titulares da posicao ${pos}`);
      else if (reserve.categoriaId! > Math.min(...matching.map(a => a.categoriaId!))) {
        throw new BadRequestException(`Categoria do reserva ${reserve.id} superior a menor categoria dos titulares da mesma posicao`);
      }
    }
  }
  if (s.tecnico === null) pendencias.push('Selecionar tecnico');
  if (s.capitaoAtletaId === null) pendencias.push('Selecionar capitao');
  if (s.reservaMagoAtletaId === null) pendencias.push('Selecionar Reserva do Mago');
  return { completa: pendencias.length === 0, pendencias };
}
