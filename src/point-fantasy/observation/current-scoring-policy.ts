import { SourceResponse } from './observation-source';

// Only a reviewed evidence verifier may issue this certificate. No payload field/header alone does so.
export interface CertifiedScoringObservation {
  policyVersion: string;
  temporada: number; rodada: number; payloadHash: string; baseHash: string | null;
  complete: boolean;
  order: { stream: string; sequence: bigint };
  supersedesUnorderedBase: boolean;
  correctionApproved: boolean;
}
export interface ScoringPolicyInput {
  temporada: number; rodada: number; payloadHash: string; baseHash: string | null; revision: bigint;
  points: SourceResponse;
}
export interface ScoringEvidencePolicy {
  // Synchronous/local: no I/O or HTTP inside the DB transaction.
  certify(input: ScoringPolicyInput): CertifiedScoringObservation | null;
}
export const unavailableOfficialScoringEvidence: ScoringEvidencePolicy = { certify: () => null };

/** Operational acceptance only; never a source completeness/order certificate. Explicit opt-in. */
export const partialScoringPolicy = { mode: 'PARCIAL', version: 'partial-v1', broadOmissionRatio: 0.5 } as const;
export type PartialScoringPolicy = typeof partialScoringPolicy;

export function certificateError(certificate: CertifiedScoringObservation | null, input: ScoringPolicyInput,
  previous: { stream: string; sequence: bigint } | null, validated: boolean): string | null {
  if (!certificate) return 'OFFICIAL_EVIDENCE_UNAVAILABLE';
  if (certificate.temporada !== input.temporada || certificate.rodada !== input.rodada
    || certificate.payloadHash !== input.payloadHash || certificate.baseHash !== input.baseHash
    || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(certificate.policyVersion)
    || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(certificate.order.stream)
    || typeof certificate.order.sequence !== 'bigint' || certificate.order.sequence < 0n) return 'INVALID_SOURCE_CERTIFICATE';
  if (certificate.complete !== true) return 'COMPLETENESS_UNPROVEN';
  if (previous && certificate.order.stream !== previous.stream) return 'SOURCE_ORDER_STREAM_CHANGED';
  if (previous && certificate.order.sequence <= previous.sequence) return 'SOURCE_ORDER_NOT_NEWER';
  if (!previous && input.revision > 0n && certificate.supersedesUnorderedBase !== true) return 'BASE_ORDER_UNPROVEN';
  if (validated && certificate.correctionApproved !== true) return 'CORRECTION_NOT_CERTIFIED';
  return null;
}
export function suspiciousCache(response: SourceResponse): string | null {
  const headers = response.headers;
  if (headers.age !== undefined && (!/^\d+$/.test(headers.age) || BigInt(headers.age) > 0n)) return 'CACHED_OR_INVALID_AGE';
  if (headers.date !== undefined) {
    const date = Date.parse(headers.date), received = Date.parse(response.receivedAt);
    if (!Number.isFinite(date) || !Number.isFinite(received) || date > received) return 'INVALID_SOURCE_DATE';
  }
  // Absence or monotonicity of Date/Last-Modified is never a freshness authorization.
  return null;
}
