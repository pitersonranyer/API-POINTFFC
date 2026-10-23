/** Test-only protocol models. Not a production admission gate or administrative command. */
export class IsolatedWriterGate {
  private state: 'LEGACY' | 'DRAINING' | 'STOPPED' | 'CURRENT' = 'LEGACY';
  private running = 0;
  async run<T>(writer: 'LEGACY' | 'CURRENT', action: () => Promise<T>): Promise<T> {
    if (this.state !== writer) throw Error('WRITER_NOT_ADMITTED');
    this.running++;
    try { return await action(); } finally { this.running--; }
  }
  stopLegacy() { if (this.state === 'LEGACY') this.state = 'DRAINING'; }
  stopAll() { if (this.state === 'LEGACY' || this.state === 'CURRENT') this.state = 'DRAINING'; }
  drained() {
    if (this.state !== 'DRAINING' && this.state !== 'STOPPED') throw Error('INVALID_GATE_STATE');
    if (this.running) throw Error('OPERATIONS_RUNNING');
    this.state = 'STOPPED';
  }
  enableCurrent(checks: { migration: boolean; backfill: boolean; noLease: boolean }) {
    if (!['STOPPED','CURRENT'].includes(this.state) || this.running || !checks.migration || !checks.backfill || !checks.noLease) throw Error('CUTOVER_PRECONDITION');
    this.state = 'CURRENT';
  }
}

export type ReviewReference = { season: number; round: number; revision: string; baseHash: string;
  candidateHash: string; payloadValid: boolean; identityValid: boolean; validated: boolean };
export type ReviewDecision = { operation: string; actor: string; justification: string;
  action: 'KEEP_CURRENT' | 'REQUEST_NEW_OBSERVATION'; decidedAt: string; reference: ReviewReference };
/** Records non-applying decisions only; never grants permission to bypass the partial policy. */
export class IsolatedReviewLedger {
  private decisions = new Map<string, string>();
  record(decision: ReviewDecision, current: ReviewReference): ReviewDecision {
    const serialized = JSON.stringify(decision);
    const prior = this.decisions.get(decision.operation);
    if (prior) {
      if (prior !== serialized) throw Error('REVIEW_OPERATION_CONFLICT');
      return JSON.parse(prior) as ReviewDecision;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decision.operation) || !decision.actor.trim() || !decision.justification.trim()
      || !Number.isFinite(Date.parse(decision.decidedAt))
      || !['KEEP_CURRENT','REQUEST_NEW_OBSERVATION'].includes(decision.action)) throw Error('INVALID_REVIEW');
    if (!current.payloadValid || !current.identityValid || current.validated
      || !decision.reference.payloadValid || !decision.reference.identityValid || decision.reference.validated) throw Error('UNREVIEWABLE_CANDIDATE');
    if (JSON.stringify(decision.reference) !== JSON.stringify(current)) throw Error('STALE_REVIEW_BASE');
    this.decisions.set(decision.operation, serialized);
    return JSON.parse(serialized) as ReviewDecision;
  }
}
