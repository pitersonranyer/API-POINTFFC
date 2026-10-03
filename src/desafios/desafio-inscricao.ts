import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MinhaDesafioInscricaoDto } from './dto/desafio-participacao.dto';

export const minhaDesafioInscricaoSelect = {
  id: true, desafioId: true, status: true, valorInscricao: true, dataInscricao: true, sequencia: true,
} satisfies Prisma.DesafioInscricaoSelect;

export type MinhaDesafioInscricaoRow = Prisma.DesafioInscricaoGetPayload<{ select: typeof minhaDesafioInscricaoSelect }>;

export function mapearMinhaDesafioInscricao(row: MinhaDesafioInscricaoRow): MinhaDesafioInscricaoDto {
  return { id: row.id, desafioId: row.desafioId, status: row.status,
    numero: row.sequencia, nome: `Palpite ${row.sequencia}`,
    valorInscricao: row.valorInscricao.toFixed(2), dataInscricao: row.dataInscricao.toISOString() };
}

// Chamadores devem manter o lock de DESAFIO antes de resolver/criar a cartela.
// Endpoints legados continuam apontando exclusivamente para Palpite 1.
export async function resolverDesafioInscricao(tx: Prisma.TransactionClient, desafioId: number, usuarioId: number,
  inscricaoId?: number): Promise<MinhaDesafioInscricaoRow> {
  if (inscricaoId !== undefined) {
    const row = await tx.desafioInscricao.findFirst({ where: { id: inscricaoId, desafioId, usuarioId },
      select: minhaDesafioInscricaoSelect });
    if (!row) throw new NotFoundException('Cartela nao encontrada neste Desafio para este usuario.');
    return row;
  }
  const row = await tx.desafioInscricao.findUnique({
    where: { desafioId_usuarioId_sequencia: { desafioId, usuarioId, sequencia: 1 } }, select: minhaDesafioInscricaoSelect,
  });
  return row ?? tx.desafioInscricao.create({ data: { desafioId, usuarioId, sequencia: 1, status: 'RASCUNHO',
    valorInscricao: new Prisma.Decimal(0) }, select: minhaDesafioInscricaoSelect });
}
