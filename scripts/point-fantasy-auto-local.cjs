const fs=require('fs'),{randomUUID}=require('crypto');
async function main(args=process.argv.slice(2)) {
  require('reflect-metadata');require('dotenv').config({quiet:true});
  const auth=require('../dist/point-fantasy/observation/local-scoring-authorization');
  const url=auth.localScoringDestination(process.env.DATABASE_URL,true).toString();
  if(args[0]==='prepare') {
    const [,season,round,file,...extra]=args;
    if(!file||extra.length>1||(extra.length===1&&extra[0]!=='--historical-test'))throw Error('USE_PREPARE_SEASON_ROUND_FILE');
    const {PrismaService}=require('../dist/prisma/prisma.service'),db=new PrismaService({datasources:{db:{url}}});
    try{
      const draft=await auth.prepareLocalScoringApproval(db,url,Number(season),Number(round),randomUUID());
      draft.automation={intervalMs:180000,scopes:[{season:draft.season,round:draft.round,generation:draft.generation}]};
      if(extra[0]==='--historical-test')draft.automation.historicalTest={season:draft.season,round:draft.round};
      fs.writeFileSync(file,JSON.stringify(draft,null,2),{flag:'wx'});console.log(JSON.stringify({prepared:true,approved:false,file}));
    }finally{await db.$disconnect();}return;
  }
  if(args.length!==1)throw Error('USE_AUTOMATION_APPROVAL_FILE');
  const {NestFactory}=require('@nestjs/core');
  const {LocalScoringAutomationModule,LocalScoringScheduler}=require('../dist/point-fantasy/observation/local-scoring-scheduler');
  const app=await NestFactory.createApplicationContext(LocalScoringAutomationModule.configure(args[0],url));
  let closing=false;
  const stop=async()=>{if(closing)return;closing=true;await app.get(LocalScoringScheduler).stop();await app.close();};
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
}
if(require.main===module)main().catch(e=>{console.error(e.code||(/^[A-Z_0-9]+$/.test(e.message)?e.message:'AUTOMATION_START_FAILED'));process.exitCode=1;});
module.exports={main};
