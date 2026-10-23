import { Prisma } from '@prisma/client';

export const OBSERVATION_TRANSACTION_ATTEMPTS = 4;

export function isObservationDeadlock(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === 'P2034' || (error.code === 'P2010'
    && (error.meta?.code === '1213' || error.meta?.code === 1213));
}

/** Repeat the whole DB transaction, never an individual statement or the HTTP collection. */
export async function retryObservationTransaction<T>(run: () => Promise<T>, retryUniqueConflict = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (error) {
      // Acquisition alone can race on the operation UUID; retry then reads its committed owner.
      const operationRace = retryUniqueConflict && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      if (attempt + 1 >= OBSERVATION_TRANSACTION_ATTEMPTS || (!isObservationDeadlock(error) && !operationRace)) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
