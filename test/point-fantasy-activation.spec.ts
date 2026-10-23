import { randomUUID } from 'crypto';
import { IsolatedReviewLedger, IsolatedWriterGate, ReviewDecision, ReviewReference } from './support/scoring-activation-model';

describe('test-only admission and non-applying administrative review protocol',()=>{
  const reference:ReviewReference={season:2026,round:31,revision:'2',baseHash:'base',candidateHash:'candidate',payloadValid:true,identityValid:true,validated:false};
  const decision=():ReviewDecision=>({operation:randomUUID(),actor:'fixture-admin',justification:'fixture comparison reviewed',action:'KEEP_CURRENT',decidedAt:'2026-10-20T18:00:00Z',reference:{...reference}});
  it('closes admission, drains admitted legacy work and requires verified prerequisites',async()=>{
    const gate=new IsolatedWriterGate();let release!:()=>void;
    const running=gate.run('LEGACY',()=>new Promise<void>(resolve=>{release=resolve;}));
    gate.stopLegacy();gate.stopLegacy();expect(()=>gate.drained()).toThrow('OPERATIONS_RUNNING');
    await expect(gate.run('LEGACY',async()=>{})).rejects.toThrow('WRITER_NOT_ADMITTED');
    await expect(gate.run('CURRENT',async()=>{})).rejects.toThrow('WRITER_NOT_ADMITTED');
    release();await running;gate.drained();gate.drained();
    expect(()=>gate.enableCurrent({migration:true,backfill:false,noLease:true})).toThrow('CUTOVER_PRECONDITION');
    gate.enableCurrent({migration:true,backfill:true,noLease:true});
    gate.enableCurrent({migration:true,backfill:true,noLease:true});
    await expect(gate.run('CURRENT',async()=>42)).resolves.toBe(42);
    await expect(gate.run('LEGACY',async()=>{})).rejects.toThrow('WRITER_NOT_ADMITTED');
    gate.stopAll();await expect(gate.run('CURRENT',async()=>{})).rejects.toThrow('WRITER_NOT_ADMITTED');gate.drained();
  });
  it('records actor, justification, immutable references and idempotent operation without granting application',()=>{
    const ledger=new IsolatedReviewLedger(),d=decision(),saved=ledger.record(d,reference);
    saved.reference.baseHash='mutated';expect(ledger.record(d,reference).reference.baseHash).toBe('base');
    expect(()=>ledger.record({...d,justification:'different'},reference)).toThrow('REVIEW_OPERATION_CONFLICT');
  });
  it.each([{revision:'3'},{baseHash:'other'},{candidateHash:'other'},{season:2025},{round:30}])('rejects a decision on changed references %#',change=>{
    expect(()=>new IsolatedReviewLedger().record(decision(),{...reference,...change})).toThrow('STALE_REVIEW_BASE');
  });
  it.each([{identityValid:false},{payloadValid:false},{validated:true}])('never bypasses identity, payload or validated protection %#',change=>{
    expect(()=>new IsolatedReviewLedger().record(decision(),{...reference,...change})).toThrow('UNREVIEWABLE_CANDIDATE');
  });
  it('requires a named actor, reason and non-applying action',()=>{
    const ledger=new IsolatedReviewLedger();expect(()=>ledger.record({...decision(),actor:''},reference)).toThrow('INVALID_REVIEW');
    expect(()=>ledger.record({...decision(),justification:''},reference)).toThrow('INVALID_REVIEW');
    expect(()=>ledger.record({...decision(),action:'APPLY' as 'KEEP_CURRENT'},reference)).toThrow('INVALID_REVIEW');
  });
});
