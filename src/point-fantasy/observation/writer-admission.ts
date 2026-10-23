import { Prisma } from '@prisma/client';
import { ObservationError } from './official-normalizer';
import { isObservationDeadlock } from './observation-retry';

export type WriterMode = 'LEGADO' | 'BLOQUEADO' | 'ATUAL';
export interface AdmissionRow { MODO: WriterMode; GERACAO: bigint; ATUAL_JA_HABILITADO: boolean }
export async function assertAdmissionGuards(tx: Prisma.TransactionClient) {
  try { await tx.$executeRaw`CALL FANTASY_VERIFY_ADMISSION()`; }
  catch (error) {
    if (isObservationDeadlock(error)) throw error;
    throw new ObservationError('ADMISSION_GUARDS_INCOMPLETE');
  }
}

/** Pre-0030 schemas retain their previous behavior, never an assertion of exclusivity.
 * Once installed, missing scope/partial metadata fails closed. DB triggers also guard old binaries. */
export async function assertWriterAdmission(tx: Prisma.TransactionClient, season: number, round: number,
  writer: 'SNAPSHOT_LEGADO' | 'ATUAL', expected?: bigint | null): Promise<bigint | null> {
  const [schema] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_ESCRITA_CONTROLE','FANTASY_ESCRITA_TRANSICAO')`;
  if (Number(schema.n) === 0) {
    if (expected !== undefined && expected !== null) throw new ObservationError('ADMISSION_SCHEMA_LOST');
    return null;
  }
  if (Number(schema.n) !== 2) throw new ObservationError('ADMISSION_SCHEMA_INCOMPLETE');
  await assertAdmissionGuards(tx);
  const [row] = await tx.$queryRaw<AdmissionRow[]>`SELECT MODO,GERACAO,ATUAL_JA_HABILITADO FROM FANTASY_ESCRITA_CONTROLE
    WHERE TEMPORADA=${season} AND RODADA=${round} FOR UPDATE`;
  if (!row || row.MODO !== (writer === 'ATUAL' ? 'ATUAL' : 'LEGADO')) throw new ObservationError('ADMISSION_WRITER_BLOCKED');
  if (expected !== undefined && expected !== row.GERACAO) throw new ObservationError('ADMISSION_GENERATION_CHANGED');
  return row.GERACAO;
}
