import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { WriterAdmissionService } from '../src/point-fantasy/observation/writer-admission.service';
import { PrismaService } from '../src/prisma/prisma.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const x = require('../scripts/point-fantasy-local-migrations.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const m = require('../scripts/point-fantasy-local-maintenance.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfill, backfillOperationId } = require('../scripts/point-fantasy-scoring-backfill.cjs');
describe('local-only maintenance capabilities, entirely mocked database', () => {
  const url = 'mysql://fixture:fixture@127.0.0.1:3306/fantasy_point_do_jogador';
  const server = '12345678-1234-1234-1234-123456789abc';
  let grant: any, request: any, tx: any, db: any, current: any, histories: any[];
  beforeEach(() => {
    const plan = { homologated:true,identity:{server},files:x.sqlFiles(),history:[],boundaries:{[x.names[1]]:['fixture-schema']},backup:{file:'fixture-backup.sql',hash:x.hash('backup')} };
    const originalRead = fs.readFileSync;
    jest.spyOn(fs,'readFileSync').mockImplementation(((file: any, ...args: any[]) => file === 'fixture-plan.json' ? Buffer.from(JSON.stringify(plan)) : file === 'fixture-backup.sql' ? Buffer.from('backup') : (originalRead as any)(file,...args)) as any);
    histories = x.names.map((name: string,i: number)=>({migration_name:name,checksum:x.pinned[i],finished_at:new Date(),rolled_back_at:null}));
    jest.spyOn(x,'history').mockImplementation(async()=>histories);
    jest.spyOn(x,'signature').mockResolvedValue('fixture-schema');
    current = {mode:null,generation:0n,fence:3n,revision:0n,hash:null,token:null,lease:null,pending:0n};
    tx = { fantasyEscritaTransicao:{findUnique:jest.fn().mockResolvedValue(null)},$queryRawUnsafe:jest.fn(async (sql: string)=>{
      if(sql.includes('@@server_uuid'))return [{name:'fantasy_point_do_jogador',server,port:3306}];
      if(sql.includes('SELECT MODO'))return current.mode ? [{MODO:current.mode,GERACAO:current.generation}] : [];
      if(sql.includes('SELECT ID,FENCE'))return [{ID:1,FENCE:current.fence,REVISAO_ATUAL:current.revision,HASH_CONTEUDO_ATUAL:current.hash,LOCK_TOKEN:current.token,LOCK_ATE:current.lease}];
      if(sql.includes('COUNT(*)'))return [{n:current.pending}];
      throw Error('Unexpected query');
    })};
    db = {$transaction:jest.fn(async (action: any)=>action(tx))};
    grant = {approved:true,writersStopped:true,operator:'fixture-operator',target:'127.0.0.1:3306/fantasy_point_do_jogador',season:2026,round:31,server,planFile:'fixture-plan.json',planHash:x.hash(x.stable(plan)),expiresAt:new Date(Date.now()+60000).toISOString(),operationIds:{initialize:randomUUID(),block:randomUUID(),enable:randomUUID(),backfill:backfillOperationId(2026,31)}};
    request = {season:2026,round:31,target:'LEGADO',operationId:grant.operationIds.initialize,operator:grant.operator,reason:'fixture only',expectedMode:null,expectedGeneration:0n,expectedFence:3n,expectedRevision:0n,expectedHash:null};
  });
  afterEach(()=>jest.restoreAllMocks());
  it('issues only after read-only checks and binds action, actor, UUID, scope and references', async()=>{
    const auth = await m.authorizeMaintenance(db,url,grant,request,'INICIALIZAR');
    await expect(m.assertMaintenance(tx,auth,url,request,'INICIALIZAR')).resolves.toBeUndefined();
    for(const changed of [{...request,round:30},{...request,operationId:randomUUID()},{...request,operator:'other'},{...request,expectedFence:4n}])expect(()=>m.assertScope(auth,url,changed,'INICIALIZAR')).toThrow('CAPABILITY_SCOPE_MISMATCH');
    expect(()=>m.assertScope(auth,url,request,'RECUPERAR')).toThrow('CAPABILITY_SCOPE_MISMATCH');
  });
  it.each(['fence','generation','revision'])('rejects changed %s after capability issuance',async key=>{
    const auth = await m.authorizeMaintenance(db,url,grant,request,'INICIALIZAR');
    if(key==='generation'){current.mode='LEGADO';current.generation=1n;}else current[key]++;
    await expect(m.assertMaintenance(tx,auth,url,request,'INICIALIZAR')).rejects.toThrow('REFERENCE_CHANGED');
  });
  it('rejects missing migrations and changed schema',async()=>{
    histories.pop();await expect(m.authorizeMaintenance(db,url,grant,request,'INICIALIZAR')).rejects.toThrow('MIGRATIONS_INVALID');
    histories=x.names.map((name: string,i: number)=>({migration_name:name,checksum:x.pinned[i],finished_at:new Date(),rolled_back_at:null}));
    x.signature.mockResolvedValue('tampered');await expect(m.authorizeMaintenance(db,url,grant,request,'INICIALIZAR')).rejects.toThrow('SCHEMA_OR_HISTORY_CHANGED');
  });
  it('rejects absent writer-stop approval, wrong server and expired grant',async()=>{
    for(const changed of [{...grant,writersStopped:false},{...grant,approved:false},{...grant,expiresAt:new Date(0).toISOString()}])await expect(m.authorizeMaintenance(db,url,changed,request,'INICIALIZAR')).rejects.toThrow('APPROVAL_REQUIRED');
    await expect(m.authorizeMaintenance(db,url,{...grant,server:randomUUID()},request,'INICIALIZAR')).rejects.toThrow('PLAN_CHANGED');
  });
  it('rejects live/conflicting work even if a file asserts the writers stopped',async()=>{
    current.token=randomUUID();await expect(m.authorizeMaintenance(db,url,grant,request,'INICIALIZAR')).rejects.toThrow('SCOPE_NOT_DRAINED');
    current.token=null;current.pending=1n;await expect(m.authorizeMaintenance(db,url,grant,request,'INICIALIZAR')).rejects.toThrow('SCOPE_NOT_DRAINED');
  });
  it('backfill remains blocked unless mode is BLOQUEADO and the operation is bound',async()=>{
    current.mode='ATUAL'; request={...request,target:'BLOQUEADO',operationId:grant.operationIds.backfill,expectedMode:'ATUAL'};
    await expect(m.authorizeMaintenance(db,url,grant,request,'BACKFILL')).rejects.toThrow('BACKFILL_NOT_BLOCKED');
    current.mode='BLOQUEADO';request.expectedMode='BLOQUEADO';const auth=await m.authorizeMaintenance(db,url,grant,request,'BACKFILL');
    expect(m.boundBackfillRequest(auth,2026,31,grant.operationIds.backfill)).toEqual(request);
    expect(()=>m.boundBackfillRequest(auth,2026,30,grant.operationIds.backfill)).toThrow('CAPABILITY_SCOPE_MISMATCH');
  });
  it('forged capability cannot open a backfill connection or an administrative transaction',async()=>{
    await expect(backfill(url,2026,31,{})).rejects.toThrow('CAPABILITY_SCOPE_MISMATCH');
    const service=new WriterAdmissionService(db as PrismaService,url,{});
    await expect(service.initialize(request)).rejects.toThrow('CAPABILITY_SCOPE_MISMATCH');expect(db.$transaction).not.toHaveBeenCalled();
    await expect(backfill(url,2026,31)).rejects.toThrow('ISOLATED_LOCAL_SCHEMA_REQUIRED');
  });
  it.each(['mysql://x:y@remote/fantasy_point_do_jogador','mysql://x:y@127.0.0.1:3307/fantasy_point_do_jogador','mysql://x:y@127.0.0.1/other'])('rejects destination %s',url=>{expect(()=>m.destination(url)).toThrow('DESTINATION_FORBIDDEN');});
  it('rejects production and Render',()=>{
    for(const key of ['NODE_ENV','RENDER_SERVICE_ID']){const old=process.env[key];try{process.env[key]=key==='NODE_ENV'?'production':'fixture';expect(()=>m.destination(url)).toThrow('DESTINATION_FORBIDDEN');}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}}
  });
  it('permits a missing pristine scope only for explicitly authorized initialization',async()=>{
    const original=tx.$queryRawUnsafe.getMockImplementation();
    tx.$queryRawUnsafe.mockImplementation(async(sql:string,...args:any[])=>sql.includes('SELECT ID,FENCE')?[]:original(sql,...args));
    await expect(m.state(tx,2026,31)).rejects.toThrow('SCOPE_NOT_DRAINED');
    expect(await m.state(tx,2026,31,true)).toEqual({expectedMode:null,expectedGeneration:0n,expectedFence:0n,expectedRevision:0n,expectedHash:null});
    request.expectedFence=0n;
    const auth=await m.authorizeMaintenance(db,url,grant,request,'INICIALIZAR');expect(()=>m.assertScope(auth,url,request,'TRANSICIONAR')).toThrow('CAPABILITY_SCOPE_MISMATCH');
  });
});
