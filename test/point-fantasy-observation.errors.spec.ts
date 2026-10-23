import { persistenceCode, PersistenceStage } from '../src/point-fantasy/observation/observation-errors';
import { ObservationError } from '../src/point-fantasy/observation/official-normalizer';

describe('sanitized persistence classification',()=>{
  it.each(['LEASE_ACQUIRE','SNAPSHOT_INSERT','ATHLETE_BATCH','COLLECTION_ASSOCIATE','COMMIT','RECOVERY'] as PersistenceStage[])('identifies stage %s',stage=>{
    expect(persistenceCode(new Error('password and SQL must not escape'),stage)).toBe('DB_'+stage+'_FAILED');
  });
  it('identifies connection and integrity errors without their messages',()=>{
    expect(persistenceCode({code:'P1001',message:'private'},'COMMIT')).toBe('DB_CONNECTION_FAILED');
    expect(persistenceCode({code:'P2003',message:'private'},'ATHLETE_BATCH')).toBe('DB_INTEGRITY_FAILED_ATHLETE_BATCH');
  });
  it('preserves authorization and idempotency codes',()=>{
    expect(persistenceCode(new ObservationError('AUTHORIZATION_LOST'),'COMMIT')).toBe('AUTHORIZATION_LOST');
    expect(persistenceCode(new ObservationError('OPERATION_CONFLICT'),'LEASE_ACQUIRE')).toBe('OPERATION_CONFLICT');
  });
});
