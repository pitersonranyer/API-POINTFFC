import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ObservationError, sha256 } from './official-normalizer';
import { ObservationSource, SourceResponse } from './observation-source';
import { stableJson } from './current-scoring-plan';
import { assertWriterAdmission } from './writer-admission';

// Reuse the exact schema verifier from the homologated local migration executor.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signature }: { signature(db: Prisma.TransactionClient): Promise<string> } = require('../../../scripts/point-fantasy-local-migrations.cjs');
export const localScoringMigrations = Object.freeze({
  '0029_point_fantasy_current_scoring': 'df2a5744867641f015ed6e28d447d66ffd705f589ec7c6f2c270d12f913e9c48',
  '0030_point_fantasy_writer_admission': '57b2cb49a10f6a33e6673196fed5986fee120431f3aebeb93f26b57b4d936bb8',
});
// Full schema, including CHECKs, trigger/procedure bodies; captured from the restored 0029/0030 rehearsal.
export const localScoringSchema = 'c49015b683323cbfd2ac9353ce307f1e68fc77665f14c764f017939aff739008';
export interface LocalScoringApproval {
  version: 1; approved: boolean; operator: string; policy: 'partial-v1';
  host: '127.0.0.1'; port: 3306; schema: string; server: string;
  season: number; round: number; operationId: string; generation: string;
  expiresAt: string; migrations: Record<keyof typeof localScoringMigrations, string>; schemaSignature: string;
  reason?: string;
  review?: { collectionId: number; payloadHash: string; evidenceHash: string; baseRevision: string; baseHash: string; validatedRevision: string };
}
declare const capability: unique symbol;
export type LocalScoringAuthorization = { readonly [capability]: true };
const bindings = new WeakMap<LocalScoringAuthorization, Readonly<LocalScoringApproval>>();
export const localScoringContext = (auth?: LocalScoringAuthorization) => auth ? bindings.get(auth) : undefined;
function deny(reason: string): never { throw new ObservationError('ADMISSION_LOCAL_' + reason); }
export function assertLocalRuntime(): void {
  if (process.env.NODE_ENV?.toLowerCase() === 'production' || ['RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_HOSTNAME'].some(k => !!process.env[k])) deny('ENVIRONMENT_FORBIDDEN');
}
export function localScoringDestination(value: string, principalOnly = false): URL {
  assertLocalRuntime();
  let u: URL; try { u = new URL(value); } catch { return deny('DESTINATION_INVALID'); }
  if (u.protocol !== 'mysql:' || u.hostname !== '127.0.0.1' || (u.port || '3306') !== '3306' || u.search || u.hash
    || !(u.pathname === '/fantasy_point_do_jogador' || (!principalOnly && /^\/point_fantasy_observation_3b2_test_\d+$/.test(u.pathname)))) deny('DESTINATION_FORBIDDEN');
  return u;
}
export function assertLocalScoringScope(auth: LocalScoringAuthorization, url: string, season: number, round: number, operationId: string): void {
  const u = localScoringDestination(url), b = bindings.get(auth);
  if (!b || u.pathname.slice(1) !== b.schema || season !== b.season || round !== b.round || operationId !== b.operationId) deny('SCOPE_MISMATCH');
  if (Date.parse(b.expiresAt) <= Date.now()) deny('EXPIRED');
}
async function inspect(tx: Prisma.TransactionClient, url: string, season: number, round: number, operationId: string, generation?: bigint, checkLease = true) {
  const u = localScoringDestination(url);
  if (!Number.isInteger(season) || season < 2000 || season > 65535 || !Number.isInteger(round) || round < 1 || round > 38
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) deny('INVALID_PARAMETERS');
  const [identity] = await tx.$queryRaw<Array<{ name: string; server: string; port: number | bigint }>>`SELECT DATABASE() AS name,@@server_uuid AS server,@@port AS port`;
  if (identity.name !== u.pathname.slice(1) || Number(identity.port) !== 3306 || !/^[0-9a-f-]{36}$/i.test(identity.server)) deny('SERVER_MISMATCH');
  const rows = await tx.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations
    WHERE migration_name IN ('0029_point_fantasy_current_scoring','0030_point_fantasy_writer_admission') OR (finished_at IS NULL AND rolled_back_at IS NULL)`;
  if (rows.some(r => !r.finished_at && !r.rolled_back_at)) deny('MIGRATIONS_INVALID');
  for (const [name, checksum] of Object.entries(localScoringMigrations)) {
    const matching = rows.filter(r => r.migration_name === name);
    if (matching.some(r => r.checksum !== checksum || (!r.finished_at && !r.rolled_back_at))
      || matching.filter(r => r.finished_at && !r.rolled_back_at).length !== 1) deny('MIGRATIONS_INVALID');
  }
  if (await signature(tx) !== localScoringSchema) deny('SCHEMA_INVALID');
  const currentGeneration = await assertWriterAdmission(tx, season, round, 'ATUAL', generation);
  if (currentGeneration === null) deny('MIGRATIONS_INVALID');
  if (checkLease) {
    const [r] = await tx.$queryRaw<Array<{ id: number; busy: number | bigint }>>`SELECT ID AS id,IF(LOCK_ATE>UTC_TIMESTAMP(3),1,0) AS busy
      FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=${season} AND RODADA=${round} FOR UPDATE`;
    const prior = await tx.fantasyPontuacaoColeta.findUnique({ where: { operacaoId: operationId } });
    if (prior && (prior.rodadaId !== Number(r?.id) || prior.modeloPersistencia !== 'ATUAL')) deny('OPERATION_CONFLICT');
    // Same UUID may read its existing result, including EM_ANDAMENTO; it never acquires a second lease.
    if (Number(r?.busy) && !prior) deny('LEASE_CONFLICT');
  }
  return { identity, generation: currentGeneration };
}
export async function prepareLocalScoringApproval(db: PrismaService, url: string, season: number, round: number, operationId: string): Promise<LocalScoringApproval> {
  const u = localScoringDestination(url);
  const state = await db.$transaction(tx => inspect(tx, url, season, round, operationId), { isolationLevel: 'Serializable', timeout: 20000 });
  return { version: 1, approved: false, operator: '', reason: '', policy: 'partial-v1', host: '127.0.0.1', port: 3306,
    schema: u.pathname.slice(1), server: state.identity.server, season, round, operationId, generation: state.generation.toString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), migrations: localScoringMigrations, schemaSignature: localScoringSchema };
}
export async function prepareLocalReviewApproval(db: PrismaService, url: string, season: number, round: number, operationId: string, collectionId: number): Promise<LocalScoringApproval> {
  const draft = await prepareLocalScoringApproval(db,url,season,round,operationId);
  const candidate = await db.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id: collectionId }, include: { rodada: true } });
  const evidence = candidate.evidenciaEncerramento as Record<string, unknown> | null;
  if (candidate.rodada.temporada !== season || candidate.rodada.rodada !== round || candidate.erroCodigo !== 'PARTIAL_VALIDATED_ROUND_BLOCKED'
    || !candidate.payloadRecebido || candidate.hashPayload !== sha256(candidate.payloadRecebido) || evidence?.kind !== 'CONTROLLED_SCORING_REVIEW'
    || evidence.baseRevision !== candidate.rodada.revisaoAtual.toString() || evidence.baseHash !== candidate.rodada.hashConteudoAtual
    || evidence.validatedRevision !== candidate.rodada.revisaoValidada?.toString()) deny('REVIEW_REFERENCE_CHANGED');
  return { ...draft, review: { collectionId, payloadHash: candidate.hashPayload!, evidenceHash: sha256(stableJson(candidate.evidenciaEncerramento)), baseRevision: String(evidence.baseRevision),
    baseHash: String(evidence.baseHash), validatedRevision: String(evidence.validatedRevision) } };
}
/** Replays only the exact recorded official observation approved for review; never invents fresh HTTP. */
export async function reviewedObservationSource(db: PrismaService, approval: LocalScoringApproval): Promise<ObservationSource> {
  if (!approval.review) deny('REVIEW_APPROVAL_REQUIRED');
  const candidate = await db.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id: approval.review.collectionId } });
  if (!candidate.payloadRecebido || sha256(candidate.payloadRecebido) !== approval.review.payloadHash
    || sha256(stableJson(candidate.evidenciaEncerramento)) !== approval.review.evidenceHash) deny('REVIEW_REFERENCE_CHANGED');
  const evidence = candidate.evidenciaEncerramento as unknown as { responses: { before: SourceResponse; after: SourceResponse; points: SourceResponse; matches: SourceResponse } };
  const saved = JSON.parse(JSON.stringify(evidence.responses)) as typeof evidence.responses;
  saved.points.text = candidate.payloadRecebido;
  let markets = 0;
  return { get: async endpoint => {
    if (endpoint === '/mercado/status') return markets++ === 0 ? saved.before : saved.after;
    if (endpoint === saved.points.endpoint) return saved.points;
    if (endpoint === saved.matches.endpoint) return saved.matches;
    throw new ObservationError('REVIEW_ENDPOINT_MISMATCH');
  } };
}
export async function authorizeLocalScoring(db: PrismaService, url: string, input: LocalScoringApproval): Promise<LocalScoringAuthorization> {
  localScoringDestination(url);
  if (!input || input.version !== 1 || input.approved !== true || typeof input.operator !== 'string' || !input.operator.trim() || input.operator.length > 100
    || input.policy !== 'partial-v1' || input.host !== '127.0.0.1' || input.port !== 3306 || !/^\d+$/.test(input.generation)
    || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now() || Date.parse(input.expiresAt) > Date.now() + 86400000
    || input.schemaSignature !== localScoringSchema || Object.entries(localScoringMigrations).some(([n, h]) => input.migrations?.[n as keyof typeof localScoringMigrations] !== h)) deny('APPROVAL_REQUIRED');
  const auth = Object.freeze({}) as LocalScoringAuthorization;
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) deny(input.review ? 'REVIEW_APPROVAL_REQUIRED' : 'JUSTIFICATION_REQUIRED');
  if (input.review && (!Number.isSafeInteger(input.review.collectionId) || input.review.collectionId < 1
    || !/^[a-f0-9]{64}$/.test(input.review.payloadHash) || !/^[a-f0-9]{64}$/.test(input.review.evidenceHash) || !/^[a-f0-9]{64}$/.test(input.review.baseHash)
    || !/^[1-9]\d*$/.test(input.review.baseRevision) || !/^[1-9]\d*$/.test(input.review.validatedRevision))) deny('REVIEW_APPROVAL_REQUIRED');
  const binding = Object.freeze({ ...input, migrations: localScoringMigrations, review: input.review ? Object.freeze({ ...input.review }) : undefined });
  bindings.set(auth, binding);
  try {
    assertLocalScoringScope(auth, url, input.season, input.round, input.operationId);
    await db.$transaction(tx => assertLocalScoringAuthorization(tx, auth, url, input.season, input.round, input.operationId, true), { isolationLevel: 'Serializable', timeout: 20000 });
  } catch (error) { bindings.delete(auth); throw error; }
  return auth;
}
export async function assertLocalScoringAuthorization(tx: Prisma.TransactionClient, auth: LocalScoringAuthorization, url: string, season: number, round: number, operationId: string, checkLease = false): Promise<void> {
  assertLocalScoringScope(auth, url, season, round, operationId);
  const b = bindings.get(auth)!;
  const state = await inspect(tx, url, season, round, operationId, BigInt(b.generation), checkLease);
  if (state.identity.server !== b.server) deny('SERVER_MISMATCH');
  if (b.review) {
    const r = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { temporada_rodada: { temporada: season, rodada: round } } });
    const candidate = await tx.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id: b.review.collectionId } });
    const evidence = candidate.evidenciaEncerramento as Record<string, unknown> | null;
    const prior = await tx.fantasyPontuacaoColeta.findUnique({ where: { operacaoId: operationId } });
    const alreadyApplied = prior?.estado === 'SUCESSO' && (prior.evidenciaEncerramento as Record<string, unknown> | null)?.approvedReviewId === candidate.id;
    if (candidate.rodadaId !== r.id || candidate.erroCodigo !== 'PARTIAL_VALIDATED_ROUND_BLOCKED' || candidate.hashPayload !== b.review.payloadHash
      || sha256(stableJson(candidate.evidenciaEncerramento)) !== b.review.evidenceHash
      || evidence?.baseRevision !== b.review.baseRevision || evidence?.baseHash !== b.review.baseHash || evidence?.validatedRevision !== b.review.validatedRevision
      || (!alreadyApplied && (r.revisaoAtual.toString() !== b.review.baseRevision || r.hashConteudoAtual !== b.review.baseHash
        || r.revisaoValidada?.toString() !== b.review.validatedRevision))) deny('REVIEW_REFERENCE_CHANGED');
  }
}
