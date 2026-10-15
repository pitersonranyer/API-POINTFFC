import { FantasyCatalogoAtleta, Prisma } from '@prisma/client';
import { FORMATION_COUNTS, LineupSelection } from '../src/point-fantasy/lineups/lineup.rules';

export function completeLineup(formacao = '4-3-3') {
  const athletes: FantasyCatalogoAtleta[] = [];
  const add = (posicaoId: number, categoriaId: number | null) => {
    const id = athletes.length + 1;
    athletes.push({ id, catalogoId: 3, atletaIdExterno: 1000 + id, clubeIdExterno: 263, posicaoId, statusId: 7,
      apelido: `Atleta ${id}`, precoCartola: new Prisma.Decimal(categoriaId === 3 ? 10 : 6), categoriaId,
      pointcoins: categoriaId === 3 ? 30 : categoriaId === 2 ? 20 : 10 });
    return id;
  };
  const titulares = Object.entries(FORMATION_COUNTS[formacao]).flatMap(([pos, count]) => Array.from({ length: count }, () => add(Number(pos), 3)));
  const tecnico = add(6, null);
  const reservas = [1, 3, 4, 5, FORMATION_COUNTS[formacao][2] ? 2 : 3].map(pos => add(pos, 2));
  const selection: LineupSelection = { formacao, titulares, tecnico, reservas, capitaoAtletaId: titulares[0], reservaMagoAtletaId: reservas[0] };
  return { selection, athletes };
}
