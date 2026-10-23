import { ObservationError } from './official-normalizer';
import { isObservationDeadlock } from './observation-retry';

export type PersistenceStage = 'LEASE_ACQUIRE' | 'SNAPSHOT_INSERT' | 'ATHLETE_BATCH' | 'COLLECTION_ASSOCIATE' | 'FINAL_AUTHORIZE' | 'COMMIT' | 'RECOVERY'
  | 'CURRENT_READ' | 'CURRENT_WRITE' | 'REVISION_UPDATE';
export function persistenceCode(error: unknown, stage: PersistenceStage): string {
  if (error instanceof ObservationError) return error.code;
  if (isObservationDeadlock(error)) return 'DB_TRANSACTION_CONFLICT_' + stage;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^P10(?:00|01|02|08|10|11|17)$/.test(code)) return 'DB_CONNECTION_FAILED';
  if (['P2003', 'P2004', 'P2011'].includes(code as string)) return 'DB_INTEGRITY_FAILED_' + stage;
  if (code === 'P2002') return 'DB_UNIQUE_CONFLICT_' + stage;
  if (code === 'P2034') return 'DB_TRANSACTION_CONFLICT_' + stage;
  return 'DB_' + stage + '_FAILED';
}
