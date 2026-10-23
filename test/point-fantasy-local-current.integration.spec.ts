import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CurrentScoringService } from '../src/point-fantasy/observation/current-scoring.service';
import { partialScoringPolicy } from '../src/point-fantasy/observation/current-scoring-policy';
import { ObservationSource, SourceResponse } from '../src/point-fantasy/observation/observation-source';
import { ObservationService } from '../src/point-fantasy/observation/observation.service';
import { WriterAdmissionService } from '../src/point-fantasy/observation/writer-admission.service';
import { authorizeLocalScoring, prepareLocalScoringApproval, prepareLocalReviewApproval, reviewedObservationSource } from '../src/point-fantasy/observation/local-scoring-authorization';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sql } = require('../scripts/point-fantasy-local-migrations.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfill } = require('../scripts/point-fantasy-scoring-backfill.cjs');
const url = process.env.POINT_FANTASY_LOCAL_CURRENT_TEST_URL;
(url ? describe : describe.skip)('operational local authorization on isolated restored MySQL, simulated HTTP', () => {
  jest.setTimeout(120000);
  let db: PrismaClient, count = 0;
  let season = 64001;
  const initial = '"1":{"pontuacao":-8.030000000000001,"posicao_id":4,"scout":{"DS":2}},"2":{"pontuacao":0,"posicao_id":6}';
  const cast = (client = db) => client as PrismaService;
  beforeAll(async () => {
    if (!/^mysql:\/\/.*@127\.0\.0\.1(?::3306)?\/point_fantasy_observation_3b2_test_\d+$/.test(url!)) throw Error('ISOLATED_REQUIRED');
    db = new PrismaClient({ datasources: { db: { url } }, log: [] });
    while(await db.fantasyApuracaoRodada.count({where:{temporada:season}}))season--;
  });
  afterAll(async () => { await db?.$disconnect(); });
  const row = (round: number) => db.fantasyApuracaoRodada.findUniqueOrThrow({ where: { temporada_rodada: { temporada: season, rodada: round } } });
  const athletes = (round: number) => db.fantasyPontuacaoAtleta.findMany({ where: { temporada: season, rodada: round }, orderBy: { atletaIdCartola: 'asc' } });
  async function request(round: number, target: 'LEGADO'|'BLOQUEADO'|'ATUAL') {
    const r = await db.fantasyApuracaoRodada.findUnique({ where: { temporada_rodada: { temporada: season, rodada: round } } });
    const c = await db.fantasyEscritaControle.findUnique({ where: { temporada_rodada: { temporada: season, rodada: round } } });
    return { season, round, target, operationId: randomUUID(), operator: 'isolated-fixture', reason: 'local operational CLI rehearsal', expectedMode: c?.modo ?? null, expectedGeneration: c?.geracao ?? 0n, expectedRevision: r?.revisaoAtual ?? 0n, expectedHash: r?.hashConteudoAtual ?? null, expectedFence: r?.fence ?? 0n };
  }
  async function scope(mode = 'ATUAL') {
    const round = ++count, admin = new WriterAdmissionService(cast(), url!);
    await admin.initialize(await request(round, 'LEGADO'));
    if (mode !== 'LEGADO') await admin.transition(await request(round, 'BLOQUEADO'));
    if (mode === 'ATUAL') await admin.transition(await request(round, 'ATUAL'));
    return round;
  }
  function source(round: number, rows = initial, extras: { error?: string; age?: string; hold?: () => Promise<void> } = {}): ObservationSource {
    return { get: jest.fn(async (endpoint): Promise<SourceResponse> => {
      if (endpoint === '/atletas/pontuados') await extras.hold?.();
      return { endpoint, receivedAt: new Date().toISOString(), status: extras.error && endpoint === '/atletas/pontuados' ? 503 : 200,
        error: endpoint === '/atletas/pontuados' ? extras.error ?? null : null, headers: extras.age ? { age: extras.age } : {},
        text: endpoint === '/mercado/status' ? JSON.stringify({ temporada: season, rodada_atual: round, status_mercado: 2 }) : endpoint.startsWith('/partidas/') ? '{}' : `{"rodada":${round},"atletas":{${rows}}}` };
    }) };
  }
  const draft = async (round: number, operation = randomUUID()) => ({ ...await prepareLocalScoringApproval(cast(), url!, season, round, operation), approved: true, operator: 'fixture-operator', reason:'isolated authorized scoring observation' });
  async function worker(round: number, s = source(round), operation = randomUUID(), client = db) {
    const approval = await draft(round, operation), auth = await authorizeLocalScoring(cast(client), url!, approval);
    return { approval, auth, source: s, service: new CurrentScoringService(cast(client), s, url!, partialScoringPolicy, auth), collect: () => new CurrentScoringService(cast(client), s, url!, partialScoringPolicy, auth).collect(season, round, operation) };
  }
  it('loads exact negative decimal, zero, scouts and technician, then preserves identical rows and updates only changed athletes', async () => {
    const round = await scope(), first = await worker(round);
    expect(await first.collect()).toMatchObject({ estado: 'SUCESSO', atletas: 2, inseridos: 2, revisaoResultante: '1', snapshotId: null });
    const before = await athletes(round);
    expect(before[0].pontuacao!.toFixed()).toBe('-8.030000000000001'); expect(before[0].scouts).toEqual({ DS: '2' }); expect(before[1].pontuacao!.toFixed()).toBe('0'); expect(before[1].posicaoId).toBe(6);
    expect(await (await worker(round)).collect()).toMatchObject({ resultadoAplicacao: 'SEM_ALTERACAO', revisaoResultante: '1', alterados: 0 });
    expect(await athletes(round)).toEqual(before);
    const changed = initial.replace('-8.030000000000001','1.5');
    expect(await (await worker(round, source(round, changed))).collect()).toMatchObject({ resultadoAplicacao: 'APLICADA', revisaoResultante: '2', alterados: 1 });
    expect((await athletes(round))[1]).toEqual(before[1]);
  });
  it('reuses the same UUID without HTTP or a new revision, and forbids reuse for another operation/round/database', async () => {
    const round = await scope(), w = await worker(round), result = await w.collect();
    expect(await w.collect()).toEqual(result); expect(w.source.get).toHaveBeenCalledTimes(4);
    for (const [r, id] of [[round + 1, w.approval.operationId], [round, randomUUID()]] as const) await expect(w.service.collect(season, r, id)).rejects.toThrow('ADMISSION_LOCAL_SCOPE_MISMATCH');
    const other = new URL(url!); other.pathname = '/point_fantasy_observation_3b2_test_1';
    const service = new CurrentScoringService(cast(), w.source, other.toString(), partialScoringPolicy, w.auth);
    await expect(service.collect(season, round, w.approval.operationId)).rejects.toThrow('ADMISSION_LOCAL_SCOPE_MISMATCH');
  });
  it.each(['LEGADO','BLOQUEADO'])('refuses mode %s before HTTP', async mode => {
    const round = await scope(mode); await expect(draft(round)).rejects.toThrow('ADMISSION_WRITER_BLOCKED');
  });
  it('refuses missing migration, bad checksum and changed server identity', async () => {
    const round = await scope();
    await db.$executeRawUnsafe("UPDATE _prisma_migrations SET rolled_back_at=UTC_TIMESTAMP(3) WHERE migration_name='0030_point_fantasy_writer_admission' AND finished_at IS NOT NULL");
    try { await expect(draft(round)).rejects.toThrow('ADMISSION_LOCAL_MIGRATIONS_INVALID'); }
    finally { await db.$executeRawUnsafe("UPDATE _prisma_migrations SET rolled_back_at=NULL WHERE migration_name='0030_point_fantasy_writer_admission' AND finished_at IS NOT NULL"); }
    const approval = await draft(round);
    await expect(authorizeLocalScoring(cast(), url!, { ...approval, reason:'' })).rejects.toThrow('ADMISSION_LOCAL_JUSTIFICATION_REQUIRED');
    await expect(authorizeLocalScoring(cast(), url!, { ...approval, server: randomUUID() })).rejects.toThrow('ADMISSION_LOCAL_SERVER_MISMATCH');
    await expect(authorizeLocalScoring(cast(), url!, { ...approval, migrations: { ...approval.migrations, '0029_point_fantasy_current_scoring': '0'.repeat(64) } })).rejects.toThrow('ADMISSION_LOCAL_APPROVAL_REQUIRED');
    await expect(authorizeLocalScoring(cast(), url!, { ...approval, expiresAt: new Date(0).toISOString() })).rejects.toThrow('ADMISSION_LOCAL_APPROVAL_REQUIRED');
    await expect(authorizeLocalScoring(cast(), url!, { ...approval, approved: false })).rejects.toThrow('ADMISSION_LOCAL_APPROVAL_REQUIRED');
  });
  it('rejects a different actual connected database and a missing mandatory trigger', async () => {
    const round = await scope(), wrong = new URL(url!); wrong.pathname = '/point_fantasy_observation_3b2_test_1';
    await expect(prepareLocalScoringApproval(cast(), wrong.toString(), season, round, randomUUID())).rejects.toThrow('ADMISSION_LOCAL_SERVER_MISMATCH');
    const [definition] = await db.$queryRawUnsafe<any[]>('SHOW CREATE TRIGGER FPS_ADMISSAO');
    const create = Object.values(definition).find(v => typeof v === 'string' && /CREATE[\s\S]+TRIGGER/i.test(v));
    sql(url, 'DROP TRIGGER FPS_ADMISSAO;');
    try { await expect(draft(round)).rejects.toThrow('ADMISSION_LOCAL_SCHEMA_INVALID'); }
    finally { sql(url, 'DELIMITER $$\n' + create + '$$\nDELIMITER ;'); }
  });
  it('serializes concurrency with lease/fence, reuses an active UUID and refuses a competing UUID before HTTP', async () => {
    const round = await scope(); let release!: () => void, ready!: () => void;
    const held = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { ready = r; });
    const first = await worker(round, source(round, initial, { hold: async () => { ready(); await held; } }));
    const second = await worker(round);
    const running = first.collect();
    try {
      await entered;
      expect(await first.collect()).toMatchObject({ estado: 'EM_ANDAMENTO' });
      await expect(second.collect()).rejects.toThrow('ADMISSION_LOCAL_LEASE_CONFLICT'); expect(second.source.get).not.toHaveBeenCalled();
    } finally { release(); }
    expect(await running).toMatchObject({ estado: 'SUCESSO' }); expect((await row(round)).revisaoAtual).toBe(1n);
  });
  it('records HTTP failure without writing athletes', async () => {
    const round = await scope(), w = await worker(round, source(round, initial, { error: 'HTTP_503' }));
    expect(await w.collect()).toMatchObject({ estado: 'FALHA_HTTP', erroCodigo: 'HTTP_503', atletas: 0 });
    expect(await athletes(round)).toEqual([]); expect((await row(round)).lockToken).toBeNull();
  });
  it('a verified capability still refuses production, Render and any policy other than partial-v1', async () => {
    const round = await scope(), w = await worker(round);
    for (const key of ['NODE_ENV','RENDER_SERVICE_ID']) {
      const old = process.env[key];
      try { process.env[key] = key === 'NODE_ENV' ? 'production' : 'fixture'; await expect(w.service.collect(season, round, w.approval.operationId)).rejects.toThrow('ADMISSION_LOCAL_ENVIRONMENT_FORBIDDEN'); }
      finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
    }
    expect(() => new CurrentScoringService(cast(), w.source, url!, { certify: () => null }, w.auth)).toThrow('ADMISSION_LOCAL_POLICY_REQUIRED');
    expect(w.source.get).not.toHaveBeenCalled();
  });
  it('rolls back athlete writes and revision on permanent transactional failure and records the error', async () => {
    const round = await scope(); let injected = false;
    const client = new Proxy(db, { get(target, key) {
      if (key === '$transaction') return (action: any, options: any) => target.$transaction(tx => action(new Proxy(tx, { get(t, k) {
        if (k === 'fantasyPontuacaoAtleta') return new Proxy(t.fantasyPontuacaoAtleta, { get(model, method) {
          if (method === 'createMany') return async (args: any) => { await model.createMany(args); injected = true; throw Error('fixture rollback'); };
          return Reflect.get(model, method);
        } });
        return Reflect.get(t, k);
      } })), options);
      return Reflect.get(target, key);
    } });
    const result = await (await worker(round, source(round), randomUUID(), client)).collect();
    expect(injected).toBe(true); expect(result.estado).toBe('RESPOSTA_INVALIDA'); expect(result.erroCodigo).toContain('DB_CURRENT_WRITE');
    expect(await athletes(round)).toEqual([]); expect((await row(round)).revisaoAtual).toBe(0n); expect((await row(round)).lockToken).toBeNull();
  });
  it('revalidates generation after HTTP suspension and cannot finalize with revoked approval', async () => {
    const round = await scope(); const w = await worker(round, source(round, initial, { hold: async () => {
      await new WriterAdmissionService(cast(), url!).transition(await request(round, 'BLOQUEADO'));
    } }));
    await expect(w.collect()).rejects.toThrow('ADMISSION_WRITER_BLOCKED'); expect(await athletes(round)).toEqual([]);
    expect((await row(round)).revisaoAtual).toBe(0n);
  });
  it('preserves cache policy and validated revisions', async () => {
    const cachedRound = await scope();
    expect(await (await worker(cachedRound, source(cachedRound, initial, { age: '1' }))).collect()).toMatchObject({ erroCodigo: 'CACHED_OR_INVALID_AGE' });
    const round = await scope();
    const first = await (await worker(round)).collect(), before = await athletes(round);
    await db.fantasyApuracaoRodada.update({ where: { id: (await row(round)).id }, data: { estado: 'VALIDADA', revisaoValidada: 1n, coletaValidacaoId: first.coletaId, validadaEm: new Date() } });
    expect(await (await worker(round, source(round, initial.replace('-8.030000000000001','2')))).collect()).toMatchObject({ erroCodigo: 'PARTIAL_VALIDATED_ROUND_BLOCKED' });
    expect(await athletes(round)).toEqual(before);
  });
  it('persists a candidate, requires specific review approval, applies through the same writer and preserves validated history',async()=>{
    const round=await scope(),first=await(await worker(round)).collect();
    await db.fantasyApuracaoRodada.update({where:{id:(await row(round)).id},data:{estado:'VALIDADA',revisaoValidada:1n,coletaValidacaoId:first.coletaId,validadaEm:new Date()}});
    const before=await athletes(round);
    const candidate=await(await worker(round,source(round,initial.replace('-8.030000000000001','-1.5')))).collect();
    expect(candidate.erroCodigo).toBe('PARTIAL_VALIDATED_ROUND_BLOCKED');expect(await athletes(round)).toEqual(before);
    const candidateRow=await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{id:candidate.coletaId}});
    // Repeated automatic attempts can propose the same correction; they are not applied history.
    expect((await(await worker(round,source(round,initial.replace('-8.030000000000001','-1.5')))).collect()).erroCodigo).toBe('PARTIAL_VALIDATED_ROUND_BLOCKED');
    const operation=randomUUID(),approval={...await prepareLocalReviewApproval(cast(),url!,season,round,operation,candidate.coletaId),approved:true,operator:'fixture-reviewer',reason:'reviewed official exceptional correction'};
    await expect(authorizeLocalScoring(cast(),url!,{...approval,reason:''})).rejects.toThrow('ADMISSION_LOCAL_REVIEW_APPROVAL_REQUIRED');
    await expect(authorizeLocalScoring(cast(),url!,{...approval,review:{...approval.review!,evidenceHash:'0'.repeat(64)}})).rejects.toThrow('ADMISSION_LOCAL_REVIEW_REFERENCE_CHANGED');
    const auth=await authorizeLocalScoring(cast(),url!,approval),replay=await reviewedObservationSource(cast(),approval);
    const service=new CurrentScoringService(cast(),replay,url!,partialScoringPolicy,auth);
    const applied=await service.collect(season,round,operation);
    expect(applied).toMatchObject({estado:'SUCESSO',revisaoResultante:'2',alterados:1});
    expect((await athletes(round))[0].pontuacao!.toFixed()).toBe('-1.5');expect((await athletes(round))[1]).toEqual(before[1]);
    expect(await row(round)).toMatchObject({estado:'EM_REVISAO',revisaoAtual:2n,revisaoValidada:1n});
    expect(await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{id:candidate.coletaId}})).toEqual(candidateRow);
    expect(await service.collect(season,round,operation)).toEqual(applied);
    await expect(authorizeLocalScoring(cast(),url!,{...approval,operationId:randomUUID()})).rejects.toThrow('ADMISSION_LOCAL_REVIEW_REFERENCE_CHANGED');
  });
  it('applies current-season historical corrections without requiring payload season or snapshot equality',async()=>{
    const round=await scope('LEGADO'),admin=new WriterAdmissionService(cast(),url!);
    expect((await new ObservationService(cast(),source(round)).collect(season,round)).estado).toBe('SUCESSO');
    await admin.transition(await request(round,'BLOQUEADO'));await backfill(url,season,round);await admin.transition(await request(round,'ATUAL'));
    function historical(rows=initial,explicitSeason=false):ObservationSource {
      const base=source(round,rows);
      return {get:jest.fn(async endpoint=>{
        const response=await base.get(endpoint);
        if(endpoint==='/mercado/status')response.text=JSON.stringify({temporada:season,rodada_atual:round+1,status_mercado:2});
        else if(endpoint.startsWith('/atletas/')&&explicitSeason)response.text=response.text!.replace('{"rodada":','{"temporada":'+season+',"rodada":');
        return response;
      })};
    }
    const before=await athletes(round);
    expect(await(await worker(round,historical())).collect()).toMatchObject({estado:'SUCESSO',resultadoAplicacao:'SEM_ALTERACAO',revisaoResultante:'1'});
    const changed=initial.replace('-8.030000000000001','1.5');
    expect(await(await worker(round,historical(changed))).collect()).toMatchObject({estado:'SUCESSO',alterados:1,revisaoResultante:'2'});
    expect(await athletes(round)).not.toEqual(before);
    expect(await(await worker(round,historical(changed,true))).collect()).toMatchObject({estado:'SUCESSO',resultadoAplicacao:'SEM_ALTERACAO',revisaoResultante:'2'});
    const corrected=await athletes(round);
    expect(await(await worker(round,historical())).collect()).toMatchObject({erroCodigo:'PREVIOUSLY_OBSERVED_CONTENT',resultadoAplicacao:'REJEITADA'});
    expect(await athletes(round)).toEqual(corrected);
  });
});
