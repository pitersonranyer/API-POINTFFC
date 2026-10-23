import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentPersistenceContext, CurrentPersistenceResult, market, ObservationEvidence, ObservationService } from './observation.service';
import { ObservationSource, SourceResponse } from './observation-source';
import { ObservationError, sha256 } from './official-normalizer';
import { changeEvidence, currentScoringPlan, scoringFields, ScoringContent } from './current-scoring-plan';
import { certificateError, partialScoringPolicy, PartialScoringPolicy, ScoringEvidencePolicy, suspiciousCache, unavailableOfficialScoringEvidence } from './current-scoring-policy';
import { assertLocalScoringAuthorization, assertLocalScoringScope, LocalScoringAuthorization, localScoringDestination, localScoringContext } from './local-scoring-authorization';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

/** Explicit construction only. Not registered in any module, controller, script or bootstrap. */
export class CurrentScoringService extends ObservationService {
  protected override readonly persistenceModel = 'ATUAL' as const;
  private readonly expectedDatabase: string;
  constructor(db: PrismaService, source: ObservationSource, databaseUrl: string,
    private readonly policy: ScoringEvidencePolicy | PartialScoringPolicy = unavailableOfficialScoringEvidence,
    private readonly localAuthorization?: LocalScoringAuthorization) {
    super(db, source);
    const url = new URL(databaseUrl);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (localAuthorization) {
      localScoringDestination(databaseUrl);
      if (policy !== partialScoringPolicy) throw new ObservationError('ADMISSION_LOCAL_POLICY_REQUIRED');
    } else if (process.env.NODE_ENV === 'production' || url.protocol !== 'mysql:'
      || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)
      || !/^point_fantasy_observation_3b2_test_\d+$/.test(name)) throw new ObservationError('ISOLATED_CURRENT_WRITER_REQUIRED');
    this.expectedDatabase = name;
    this.databaseUrl = databaseUrl;
  }
  private readonly databaseUrl: string;
  private readonly historicalEvidence = new WeakMap<SourceResponse, Record<string, unknown>>();
  override async collect(season: number, round: number, operationId?: string) {
    if (this.localAuthorization) assertLocalScoringScope(this.localAuthorization, this.databaseUrl, season, round, operationId ?? '');
    return super.collect(season, round, operationId);
  }
  protected override async assertCollectionAuthorization(tx: Prisma.TransactionClient, season: number, round: number, operation: string, acquiring = false): Promise<void> {
    if (this.localAuthorization) await assertLocalScoringAuthorization(tx, this.localAuthorization, this.databaseUrl, season, round, operation, acquiring);
  }
  protected override async assertExecutionTarget(): Promise<void> {
    const [database] = await this.db.$queryRaw<Array<{ name: string }>>`SELECT DATABASE() AS name`;
    if (this.localAuthorization) localScoringDestination(this.databaseUrl);
    if (process.env.NODE_ENV === 'production' || database.name !== this.expectedDatabase) throw new ObservationError('ISOLATED_CURRENT_WRITER_REQUIRED');
    // Read-only preflight, never a migration or bootstrap side effect.
    await this.db.fantasyPontuacaoAtleta.findFirst({ select: { revisaoAlteracao: true } });
  }
  protected override async historicalIdentity(season: number, round: number, before: SourceResponse, after: SourceResponse, points: SourceResponse): Promise<boolean> {
    const first = market(before), last = market(after);
    this.historicalEvidence.set(points, { reason: 'HISTORICAL_MARKET_CONTEXT_INCOMPATIBLE' });
    if (!first || !last || first.temporada !== season || last.temporada !== season
      || season < 2000 || season > 65535 || Number(first.rodada_atual) < 1 || Number(first.rodada_atual) > 38
      || first.rodada_atual !== last.rodada_atual || round >= Number(first.rodada_atual)
      || first.status_mercado !== last.status_mercado || points.endpoint !== '/atletas/pontuados/' + round) return false;
    // POINT FFC business premise: this endpoint serves only the current season.
    // This is an operational assumption, not a season guarantee in the payload.
    // normalizeOfficial already checked round and any explicitly declared season.
    this.historicalEvidence.set(points, {
      method: 'POINT_FFC_CURRENT_SEASON_ENDPOINT_PREMISE', season, round,
      marketSeasonBefore: first.temporada, marketSeasonAfter: last.temporada,
    });
    return true;
  }
  protected override collectionEvidence({ before, after, matches, points }: ObservationEvidence): Prisma.FantasyPontuacaoColetaUpdateManyMutationInput {
    const operation = localScoringContext(this.localAuthorization);
    const status = (response: typeof before) => {
      const data = response ? market(response) : null;
      return response ? { httpStatus: response.status, hashPayload: response.text === null ? null : sha256(response.text),
        temporada: data?.temporada ?? null, rodada: data?.rodada_atual ?? null, statusMercado: data?.status_mercado ?? null } : null;
    };
    const headers = Object.fromEntries(['date','age','cache-control','etag','last-modified']
      .filter(key => points?.headers[key] !== undefined).map(key => [key, points!.headers[key].slice(0,1000)]));
    return { endpoint: points?.endpoint ?? '/atletas/pontuados', httpStatus: points?.status, payloadRecebido: null,
      evidenciaEncerramento: operation ? json({ operator: operation.operator, reason: operation.reason ?? null, operationId: operation.operationId }) : Prisma.DbNull,
      hashPayload: points?.text === undefined || points.text === null ? undefined : sha256(points.text),
      statusAntes: before ? json(status(before)) : Prisma.DbNull, statusDepois: after ? json(status(after)) : Prisma.DbNull, cabecalhos: json(headers),
      evidenciasPartidas: matches ? json({ httpStatus: matches.status, error: matches.error,
        hashPayload: matches.text === null ? null : sha256(matches.text), historicalIdentity: points ? this.historicalEvidence.get(points) ?? null : null }) : Prisma.DbNull };
  }
  protected override async persistCurrent(tx: Prisma.TransactionClient, c: CurrentPersistenceContext): Promise<CurrentPersistenceResult> {
    c.stage('CURRENT_READ');
    const round = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { id: c.rodadaId } });
    const existing = await tx.fantasyPontuacaoAtleta.findMany({ where: { apuracaoId: round.id }, orderBy: { atletaIdCartola: 'asc' } });
    const partial = 'mode' in this.policy;
    const operation = localScoringContext(this.localAuthorization);
    const review = operation?.review;
    const plan = currentScoringPlan(existing, c.normalized, c.temporada, c.rodada, partial);
    const receivedIds = new Set(c.normalized.athletes.map(a => a.atletaIdCartola));
    const existingById = new Map(existing.map(a => [a.atletaIdCartola, a]));
    const omittedIds = existing.filter(a => !receivedIds.has(a.atletaIdCartola)).map(a => a.atletaIdCartola);
    const retentions = c.normalized.athletes.flatMap(a => {
      const before = existingById.get(a.atletaIdCartola);
      if (!before) return [];
      const fields = (['estadoClube','estadoPosicao','estadoPontuacao','estadoParticipacao','estadoScouts'] as const)
        .filter(key => before[key] === 'VALOR' && a[key] !== 'VALOR')
        .map(key => ({ atletaIdCartola: a.atletaIdCartola, campo: key, anterior: before[key], recebido: a[key], motivo: 'INFORMED_FIELD_LOST' }));
      const missingScouts = a.estadoScouts === 'VALOR' ? Object.keys(object(before.scouts) ?? {})
        .filter(key => !Object.prototype.hasOwnProperty.call(a.scouts ?? {}, key))
        .map(key => ({ atletaIdCartola: a.atletaIdCartola, campo: `scouts.${key}`, anterior: 'VALOR', recebido: 'AUSENTE', motivo: 'INFORMED_FIELD_LOST' })) : [];
      return [...fields, ...missingScouts];
    });
    const changed = plan.changes.length > 0 || round.revisaoAtual === 0n;
    const received = c.points && Number.isFinite(Date.parse(c.points.receivedAt)) ? new Date(c.points.receivedAt) : null;
    const common: Prisma.FantasyPontuacaoColetaUpdateManyMutationInput = {
      revisaoBase: round.revisaoAtual, fonte: 'CARTOLA_PONTUADOS', versaoNormalizador: c.normalized.version,
      recebidaEm: received, qtdRecebidos: c.normalized.athletes.length,
      qtdInseridos: 0, qtdAlterados: 0, qtdOmitidos: 0,
    };
    const rejected = (failure: string): CurrentPersistenceResult => ({ accepted: false, failure, collection: {
      ...common, resultadoAplicacao: 'REJEITADA', revisaoResultante: null,
      hashConteudo: c.normalized.hashConteudo, alteracoes: [],
      limitacoes: json({ codigos: [...c.limitations, failure], hashObservado: c.normalized.hashConteudo,
        ...(partial ? { modalidade: 'PARCIAL', politica: this.policy, omitidosObservados: omittedIds, retencoes: retentions } : {}) }),
    } });
    if (!received || !c.points) return rejected('INVALID_RECEIPT_TIME');
    if ((round.revisaoAtual === 0n && existing.length > 0) || existing.some(row => row.revisaoAlteracao > round.revisaoAtual)) {
      return rejected('CURRENT_BASE_INCONSISTENT');
    }
    const legacy = await tx.fantasyPontuacaoColeta.findFirst({ where: { rodadaId: round.id,
      estado: 'SUCESSO', modeloPersistencia: 'SNAPSHOT_LEGADO' }, orderBy: [{ fence: 'desc' }, { id: 'desc' }] });
    const anchor = round.ultimaColetaAplicadaId ? await tx.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id: round.ultimaColetaAplicadaId } }) : null;
    if (legacy && (!anchor || legacy.fence > anchor.fence)) return rejected('LEGACY_WRITER_ADVANCED_BACKFILL_REQUIRED');

    // Ignore unverified/old no-change responses when finding the certified ordering floor.
    const [last] = await tx.$queryRaw<Array<{ LIMITACOES: Prisma.JsonValue; CABECALHOS: Prisma.JsonValue }>>`
      SELECT LIMITACOES, CABECALHOS FROM FANTASY_PONTUACAO_COLETA
      WHERE RODADA_ID=${round.id} AND MODELO_PERSISTENCIA='ATUAL' AND ESTADO='SUCESSO'
        AND JSON_EXTRACT(LIMITACOES, '$.evidenciaFonte.ordem.sequencia') IS NOT NULL
      ORDER BY FENCE DESC, ID DESC LIMIT 1`;
    const stored = object(object(last?.LIMITACOES)?.evidenciaFonte);
    const order = object(stored?.ordem);
    if (last && (!order || typeof order.fluxo !== 'string' || typeof order.sequencia !== 'string' || !/^\d+$/.test(order.sequencia))) {
      return rejected('SOURCE_ORDER_HISTORY_INVALID');
    }
    const previous = order ? { stream: order.fluxo as string, sequence: BigInt(order.sequencia as string) } : null;
    const input = { temporada: c.temporada, rodada: c.rodada, payloadHash: c.normalized.hashPayload,
      baseHash: round.hashConteudoAtual, revision: round.revisaoAtual, points: c.points };
    const certificate = 'certify' in this.policy ? this.policy.certify(input) : null;
    const protectedCorrection = round.revisaoValidada !== null;
    const certificationFailure = certificateError(certificate, input, previous, changed && protectedCorrection);
    const cacheFailure = suspiciousCache(c.points);
    const priorDate = object(last?.CABECALHOS)?.date;
    const olderDate = typeof priorDate === 'string' && c.points.headers.date !== undefined
      && Date.parse(c.points.headers.date) < Date.parse(priorDate);
    if (partial) {
      // No partial path can mutate a previously validated revision, including EM_REVISAO.
      if ((round.estado === 'VALIDADA' || round.revisaoValidada !== null) && !review) {
        const result = rejected('PARTIAL_VALIDATED_ROUND_BLOCKED');
        result.collection = { ...result.collection, payloadRecebido: c.points.text,
          alteracoes: plan.changes.map(change => changeEvidence(change, round.revisaoAtual + 1n)),
          evidenciaEncerramento: json({ kind: 'CONTROLLED_SCORING_REVIEW', baseRevision: round.revisaoAtual.toString(), baseHash: round.hashConteudoAtual,
            validatedRevision: round.revisaoValidada?.toString(), operator: operation?.operator ?? null, reason: operation?.reason ?? null,
            responses: { before: c.before, after: c.after, matches: c.matches, points: c.points } }) };
        return result;
      }
      if (review && (c.normalized.hashPayload !== review.payloadHash || round.revisaoAtual.toString() !== review.baseRevision
        || round.hashConteudoAtual !== review.baseHash || round.revisaoValidada?.toString() !== review.validatedRevision)) return rejected('REVIEW_REFERENCE_CHANGED');
      if (existing.length === 0 && c.normalized.athletes.length === 0) return rejected('EMPTY_PARTIAL_LIST');
      if (cacheFailure || olderDate) return rejected(cacheFailure ?? 'SOURCE_DATE_REGRESSION');
      if (retentions.length) return rejected('INFORMED_FIELD_LOST');
      if (existing.length > 0 && omittedIds.length / existing.length >= ('mode' in this.policy ? this.policy.broadOmissionRatio : 1)) return rejected('BROAD_ATHLETE_OMISSION');
      const prior = await tx.fantasyPontuacaoColeta.findFirst({ where: { rodadaId: round.id,
        modeloPersistencia: 'ATUAL', estado: 'SUCESSO' }, orderBy: [{ fence: 'desc' }, { id: 'desc' }] });
      const priorDate = object(prior?.cabecalhos)?.date;
      if (typeof priorDate === 'string' && c.points.headers.date !== undefined
        && Date.parse(c.points.headers.date) < Date.parse(priorDate)) return rejected('SOURCE_DATE_REGRESSION');
      if (changed) {
        const history = await tx.$queryRaw<Array<{ ID: number }>>`SELECT ID FROM FANTASY_PONTUACAO_COLETA
          WHERE RODADA_ID=${round.id} AND ID<>${c.coletaId} AND ID<>${review?.collectionId ?? 0}
          AND NOT (${review ? 1 : 0}=1 AND COALESCE(ERRO_CODIGO,'')='PARTIAL_VALIDATED_ROUND_BLOCKED'
            AND COALESCE(HASH_PAYLOAD,'')=${review?.payloadHash ?? ''}
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(EVIDENCIA_ENCERRAMENTO,'$.baseRevision')),'')=${review?.baseRevision ?? ''}
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(EVIDENCIA_ENCERRAMENTO,'$.baseHash')),'')=${review?.baseHash ?? ''}) AND
          (HASH_CONTEUDO=${c.normalized.hashConteudo} OR
           JSON_UNQUOTE(JSON_EXTRACT(LIMITACOES, '$.hashObservado'))=${c.normalized.hashConteudo}) LIMIT 1`;
        if (history.length) return rejected('PREVIOUSLY_OBSERVED_CONTENT');
      }
    }
    if (!partial && changed && (certificationFailure || cacheFailure || olderDate)) {
      return rejected(certificationFailure ?? cacheFailure ?? 'SOURCE_DATE_REGRESSION');
    }
    // Invalid certificates are never silently accepted, even for a no-change query.
    if (!partial && !changed && certificationFailure && certificationFailure !== 'OFFICIAL_EVIDENCE_UNAVAILABLE'
      && certificationFailure !== 'SOURCE_ORDER_NOT_NEWER') return rejected(certificationFailure);
    const certified = certificate && !certificationFailure && !cacheFailure && !olderDate ? certificate : null;
    const revision = changed ? round.revisaoAtual + 1n : round.revisaoAtual;
    const hash = changed ? plan.hash : round.hashConteudoAtual!;
    c.stage('CURRENT_WRITE');
    const metadata = { temporada: c.temporada, rodada: c.rodada, apuracaoId: round.id,
      revisaoAlteracao: revision, coletaAlteracaoId: c.coletaId };
    const data = (content: ScoringContent) => ({
      ...Object.fromEntries(scoringFields.map(key => [key, content[key]])) as ScoringContent,
      scouts: content.scouts === null ? Prisma.DbNull : content.scouts as Prisma.InputJsonValue,
    });
    const insertions = plan.changes.filter(change => !change.before);
    for (let offset = 0; offset < insertions.length; offset += 100) {
      await tx.fantasyPontuacaoAtleta.createMany({ data: insertions.slice(offset, offset + 100).map(change => ({ ...data(change.after), ...metadata })) });
    }
    for (const change of plan.changes.filter(change => change.before)) {
      const updated = await tx.fantasyPontuacaoAtleta.updateMany({ where: { temporada: c.temporada, rodada: c.rodada,
        atletaIdCartola: change.after.atletaIdCartola, apuracaoId: round.id, revisaoAlteracao: change.before!.revisaoAlteracao },
      data: { ...data(change.after), revisaoAlteracao: revision, coletaAlteracaoId: c.coletaId } });
      if (updated.count !== 1) throw new ObservationError('CURRENT_ROW_CONFLICT');
    }
    if (changed) {
      c.stage('REVISION_UPDATE');
      await tx.fantasyApuracaoRodada.update({ where: { id: round.id }, data: {
        revisaoAtual: revision, hashConteudoAtual: hash, versaoNormalizador: c.normalized.version,
        ultimaColetaAplicadaId: c.coletaId, ...(round.estado === 'VALIDADA' ? { estado: 'EM_REVISAO' } : {}),
      } });
    }
    return { accepted: true, collection: { ...common, hashConteudo: hash, revisaoResultante: revision,
      resultadoAplicacao: changed ? 'APLICADA' : 'SEM_ALTERACAO',
      qtdInseridos: plan.inserted, qtdAlterados: plan.updated, qtdOmitidos: plan.omitted,
      motivo: partial ? 'PARTIAL_OPERATIONAL_ACCEPTANCE' : protectedCorrection && changed ? 'CERTIFIED_CORRECTION_AFTER_VALIDATION' : 'DIFFERENTIAL_OBSERVATION',
      ...(review ? { evidenciaEncerramento: json({ approvedReviewId: review.collectionId, operator: operation.operator, reason: operation.reason,
        baseRevision: review.baseRevision, baseHash: review.baseHash, validatedRevision: review.validatedRevision }) } : {}),
      alteracoes: plan.changes.map(change => changeEvidence(change, revision)),
      limitacoes: json({ operator: operation?.operator ?? null, reason: operation?.reason ?? null, ...(partial ? { modalidade: 'PARCIAL', politica: this.policy, omitidosObservados: omittedIds, retencoes: [] } : {}),
        codigos: [...c.limitations, ...(partial ? ['OFFICIAL_FRESHNESS_NOT_PROVEN','COMPLETENESS_NOT_PROVEN'] : !certified ? ['NO_CHANGE_WITHOUT_NEW_FRESHNESS_PROOF'] : []),
        ...(!changed ? [certificationFailure, cacheFailure, olderDate ? 'SOURCE_DATE_REGRESSION' : null].filter(Boolean) : [])],
        hashObservado: c.normalized.hashConteudo,
        evidenciaFonte: certified ? { politica: certified.policyVersion, completa: true,
          ordem: { fluxo: certified.order.stream, sequencia: certified.order.sequence.toString() },
          correcaoAprovada: certified.correctionApproved, superaBaseSemOrdem: certified.supersedesUnorderedBase } : null }),
    } };
  }
}
