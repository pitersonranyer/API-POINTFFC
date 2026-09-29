import { Prisma } from '@prisma/client';
import { MinhaDesafioInscricaoDto } from './dto/desafio-participacao.dto';

export const minhaDesafioInscricaoSelect = {
  id: true, desafioId: true, status: true, valorInscricao: true, dataInscricao: true,
} satisfies Prisma.DesafioInscricaoSelect;

export type MinhaDesafioInscricaoRow = Prisma.DesafioInscricaoGetPayload<{ select: typeof minhaDesafioInscricaoSelect }>;

export function mapearMinhaDesafioInscricao(row: MinhaDesafioInscricaoRow): MinhaDesafioInscricaoDto {
  return { id: row.id, desafioId: row.desafioId, status: row.status,
    valorInscricao: row.valorInscricao.toFixed(2), dataInscricao: row.dataInscricao.toISOString() };
}
