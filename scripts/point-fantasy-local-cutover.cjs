// No HTTP, migrations or application bootstrap. Existing services perform every write.
const fs = require('fs');
const maintenance = require('./point-fantasy-local-maintenance.cjs');
const { backfill, backfillOperationId } = require('./point-fantasy-scoring-backfill.cjs');
const { stable } = require('./point-fantasy-local-migrations.cjs');
async function main(args = process.argv.slice(2)) {
  require('dotenv').config({ quiet:true });
  const url = maintenance.destination(process.env.DATABASE_URL).toString();
  if(args[0]==='prepare') {
    const [,season,round,planOption,planFile,authOption,file,...extra]=args;
    if(extra.length||planOption!=='--plan'||authOption!=='--authorization'||!file||!/^\d+$/.test(season)||!/^\d+$/.test(round)
      ||Number(season)<2000||Number(season)>65535||Number(round)<1||Number(round)>38)throw Error('USE_PREPARE_SEASON_ROUND_PLAN_AUTHORIZATION');
    const {randomUUID}=require('crypto'),x=require('./point-fantasy-local-migrations.cjs'),{PrismaService}=require('../dist/prisma/prisma.service');
    const plan=JSON.parse(fs.readFileSync(planFile)),db=new PrismaService({datasources:{db:{url}}});
    try{
      const [i]=await db.$queryRawUnsafe('SELECT DATABASE() AS name,@@server_uuid AS server,@@port AS port');
      if(i.name!=='fantasy_point_do_jogador'||i.server!==plan.identity.server||Number(i.port)!==3306)throw Error('SERVER_IDENTITY_CHANGED');
      const initialReference=await db.$transaction(tx=>maintenance.state(tx,Number(season),Number(round),true));
      const draft={approved:false,writersStopped:false,operator:'',target:'127.0.0.1:3306/fantasy_point_do_jogador',server:i.server,season:Number(season),round:Number(round),planFile,planHash:x.hash(x.stable(plan)),expiresAt:new Date(Date.now()+3600000).toISOString(),initialReference,
        operationIds:{initialize:randomUUID(),block:randomUUID(),backfill:backfillOperationId(Number(season),Number(round)),enable:randomUUID()}};
      fs.writeFileSync(file,x.stable(draft),{flag:'wx'});return {prepared:true,approved:false,file};
    }finally{await db.$disconnect();}
  }
  const [file, ...extra] = args; if (!file || extra.length) throw Error('USE_CUTOVER_AUTHORIZATION_FILE');
  const grant = JSON.parse(fs.readFileSync(file));
  if (grant.operationIds?.backfill !== backfillOperationId(grant.season,grant.round)) throw Error('BACKFILL_OPERATION_MISMATCH');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { WriterAdmissionService } = require('../dist/point-fantasy/observation/writer-admission.service');
  const db = new PrismaService({ datasources:{db:{url}} });
  const encode = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
  const log = (action, request, result) => { fs.appendFileSync(file+'.execution.jsonl',encode({at:new Date().toISOString(),operator:grant.operator,action,request,result})+'\n'); };
  const current = (allowMissing=false) => db.$transaction(tx => maintenance.state(tx,grant.season,grant.round,allowMissing),{isolationLevel:'Serializable',timeout:30000});
  const request = async (key,target) => ({season:grant.season,round:grant.round,target,operationId:grant.operationIds[key],operator:grant.operator,
    reason:'Authorized local deployment: legacy cutover and exact SQL backfill',...await current(key==='initialize')});
  async function admin(key,target,action) {
    const r = await request(key,target), auth = await maintenance.authorizeMaintenance(db,url,grant,r,action);
    const service = new WriterAdmissionService(db,url,auth);
    const result = await service[action==='INICIALIZAR'?'initialize':'transition'](r); log(action,r,result); return result;
  }
  try {
    let c = await db.fantasyEscritaControle.findUnique({where:{temporada_rodada:{temporada:grant.season,rodada:grant.round}}});
    if (!c) {
      if (stable(await current(true)) !== stable(grant.initialReference)) throw Error('CUTOVER_INITIAL_REFERENCE_CHANGED');
      await admin('initialize','LEGADO','INICIALIZAR');
      c = await db.fantasyEscritaControle.findUniqueOrThrow({where:{temporada_rodada:{temporada:grant.season,rodada:grant.round}}});
    }
    if (c.modo === 'LEGADO') {
      if(c.ultimaTransicaoId!==grant.operationIds.initialize)throw Error('CUTOVER_CONTROL_CONFLICT');
      await admin('block','BLOQUEADO','TRANSICIONAR');
      c = await db.fantasyEscritaControle.findUniqueOrThrow({where:{temporada_rodada:{temporada:grant.season,rodada:grant.round}}});
    }
    if (c.modo === 'BLOQUEADO') {
      if(c.ultimaTransicaoId!==grant.operationIds.block)throw Error('CUTOVER_CONTROL_CONFLICT');
      const legacy=await db.fantasyPontuacaoColeta.findFirst({where:{rodada:{temporada:grant.season,rodada:grant.round},estado:'SUCESSO',modeloPersistencia:'SNAPSHOT_LEGADO'}});
      if(legacy){
      const r = await request('backfill','BLOQUEADO'), auth = await maintenance.authorizeMaintenance(db,url,grant,r,'BACKFILL');
      const result = await backfill(url,grant.season,grant.round,auth); log('BACKFILL',r,result);
      // Reissue against the new revision; the original backfill's own exact SQL verification proves reuse.
      const repeated = await request('backfill','BLOQUEADO'), secondAuth = await maintenance.authorizeMaintenance(db,url,grant,repeated,'BACKFILL');
      const second = await backfill(url,grant.season,grant.round,secondAuth); if(!second.reused)throw Error('BACKFILL_NOT_IDEMPOTENT'); log('BACKFILL_REUSE',repeated,second);
      }else{log('BACKFILL_NOT_REQUIRED',await current(),{reason:'pristine scope is rechecked by admission service before ATUAL'});}
      await admin('enable','ATUAL','TRANSICIONAR');
      c = await db.fantasyEscritaControle.findUniqueOrThrow({where:{temporada_rodada:{temporada:grant.season,rodada:grant.round}}});
    }
    if(c.modo!=='ATUAL'||c.ultimaTransicaoId!==grant.operationIds.enable)throw Error('CUTOVER_NOT_COMPLETE');
    const finalRequest = await request('enable','ATUAL');
    // An already completed invocation must still validate server, grant and canonical schema.
    await maintenance.authorizeMaintenance(db,url,grant,finalRequest,'TRANSICIONAR');
    return {target:grant.target,season:grant.season,round:grant.round,operator:grant.operator,mode:c.modo,generation:c.geracao.toString(),backfillOperationId:grant.operationIds.backfill,httpRequests:0};
  } finally {await db.$disconnect();}
}
if(require.main===module) main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.code||(/^[A-Z_0-9]+$/.test(e.message)?e.message:'LOCAL_CUTOVER_FAILED'));process.exitCode=1;});
module.exports={main};
