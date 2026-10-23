import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import * as fs from 'fs';
import { LocalScoringScheduler, LocalAutomationApproval } from '../src/point-fantasy/observation/local-scoring-scheduler';
import * as authorization from '../src/point-fantasy/observation/local-scoring-authorization';
import { CurrentScoringService } from '../src/point-fantasy/observation/current-scoring.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CartolaObservationSource } from '../src/point-fantasy/observation/observation-source';
describe('local-only Nest scheduler, simulated HTTP/database, disabled until explicitly started',()=>{
  const url='mysql://fixture:fixture@127.0.0.1:3306/fantasy_point_do_jogador';
  let config:LocalAutomationApproval,db:any,source:any,registry:SchedulerRegistry,scheduler:LocalScoringScheduler,collect:jest.SpyInstance;
  beforeEach(()=>{
    jest.useFakeTimers();jest.spyOn(Logger.prototype,'log').mockImplementation(()=>undefined);jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
    config={version:1,approved:true,operator:'fixture-operator',reason:'automatic partial monitoring',host:'127.0.0.1',port:3306,schema:'fantasy_point_do_jogador',server:'fixture-server',season:2026,round:32,operationId:'fixture-session',generation:'2',policy:'partial-v1',migrations:authorization.localScoringMigrations,schemaSignature:authorization.localScoringSchema,expiresAt:new Date(Date.now()+3600000).toISOString(),automation:{intervalMs:180000,scopes:[{season:2026,round:32,generation:'2'}]}};
    const original=fs.readFileSync;jest.spyOn(fs,'readFileSync').mockImplementation(((file:any,...args:any[])=>file==='automation-fixture.json'?JSON.stringify(config):(original as any)(file,...args)) as any);
    db={$queryRaw:jest.fn().mockResolvedValue([{name:config.schema,server:config.server,port:3306}])};
    source={get:jest.fn().mockResolvedValue({endpoint:'/mercado/status',status:200,error:null,headers:{},receivedAt:new Date().toISOString(),text:'{"temporada":2026,"rodada_atual":32,"status_mercado":2}'})};
    jest.spyOn(authorization,'prepareLocalScoringApproval').mockImplementation(async(_db,_url,season,round,operationId)=>({...config,approved:false,season,round,operationId}));
    jest.spyOn(authorization,'authorizeLocalScoring').mockResolvedValue({} as any);
    collect=jest.spyOn(CurrentScoringService.prototype,'collect').mockResolvedValue({estado:'SUCESSO',resultadoAplicacao:'SEM_ALTERACAO'} as any);
    registry=new SchedulerRegistry();scheduler=new LocalScoringScheduler({file:'automation-fixture.json',url},db as PrismaService,registry,source as CartolaObservationSource);
  });
  afterEach(async()=>{await scheduler.stop();jest.restoreAllMocks();jest.useRealTimers();});
  it('polls every three minutes through the existing collector and stops cleanly',async()=>{
    expect(source.get).not.toHaveBeenCalled();scheduler.onModuleInit();expect(registry.getIntervals()).toEqual(['point-fantasy-current']);
    await jest.advanceTimersByTimeAsync(180000);expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0].slice(0,2)).toEqual([2026,32]);
    await jest.advanceTimersByTimeAsync(180000);expect(collect).toHaveBeenCalledTimes(2);expect(collect.mock.calls[0][2]).not.toBe(collect.mock.calls[1][2]);
    await scheduler.stop();await jest.advanceTimersByTimeAsync(180000);expect(collect).toHaveBeenCalledTimes(2);
  });
  it('skips an open market normally but permits two explicitly authorized historical ticks',async()=>{
    source.get.mockResolvedValue({status:200,error:null,text:'{"temporada":2026,"rodada_atual":32,"status_mercado":1}'});
    expect(await scheduler.tick()).toMatchObject({reason:'MARKET_NOT_CLOSED'});expect(collect).not.toHaveBeenCalled();
    config.round=31;config.automation.scopes=[{season:2026,round:31,generation:'2'}];config.automation.historicalTest={season:2026,round:31};
    scheduler.onModuleInit();await jest.advanceTimersByTimeAsync(180000);await jest.advanceTimersByTimeAsync(180000);
    expect(collect).toHaveBeenCalledTimes(2);expect(collect.mock.calls.every(c=>c[0]===2026&&c[1]===31)).toBe(true);
    await scheduler.stop();await jest.advanceTimersByTimeAsync(180000);expect(collect).toHaveBeenCalledTimes(2);
  });
  it('rejects an unauthorized historical scope before HTTP',async()=>{
    config.automation.historicalTest={season:2026,round:31};
    expect(await scheduler.tick()).toMatchObject({error:'AUTOMATION_SCOPE_NOT_AUTHORIZED'});expect(source.get).not.toHaveBeenCalled();
  });
  it('rejects historical testing in production',async()=>{
    config.automation.historicalTest={season:2026,round:32};const old=process.env.NODE_ENV;
    try{process.env.NODE_ENV='production';expect(await scheduler.tick()).toMatchObject({error:'ADMISSION_LOCAL_ENVIRONMENT_FORBIDDEN'});expect(source.get).not.toHaveBeenCalled();}finally{process.env.NODE_ENV=old;}
  });
  it('does not overlap ticks and waits for the in-flight collection when stopping',async()=>{
    let release!:(v:any)=>void;collect.mockImplementation(()=>new Promise(r=>{release=r;}));const first=scheduler.tick();
    for(let i=0;i<10;i++)await Promise.resolve();
    expect(await scheduler.tick()).toMatchObject({reason:'RUNNING_OR_STOPPING'});
    let stopped=false;const stop=scheduler.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
    release({estado:'SUCESSO'});await first;await stop;expect(collect).toHaveBeenCalledTimes(1);
  });
  it('logs a failed market HTTP and recovers on the next scheduled attempt',async()=>{
    source.get.mockResolvedValueOnce({status:503,error:'HTTP_503',text:null});
    expect(await scheduler.tick()).toMatchObject({event:'automation.failed',error:'AUTOMATION_MARKET_UNAVAILABLE'});expect(collect).not.toHaveBeenCalled();
    expect(await scheduler.tick()).toMatchObject({event:'automation.result',estado:'SUCESSO'});expect(collect).toHaveBeenCalledTimes(1);
  });
  it('logs a collector HTTP failure and uses a new UUID on the next attempt',async()=>{
    collect.mockResolvedValueOnce({estado:'FALHA_HTTP',erroCodigo:'HTTP_503'});
    expect(await scheduler.tick()).toMatchObject({estado:'FALHA_HTTP',erroCodigo:'HTTP_503'});
    expect(await scheduler.tick()).toMatchObject({estado:'SUCESSO'});expect(collect.mock.calls[0][2]).not.toBe(collect.mock.calls[1][2]);
  });
  it('will not auto-initialize a new round or accept a changed generation',async()=>{
    config.automation.scopes[0].round=31;
    expect(await scheduler.tick()).toMatchObject({error:'AUTOMATION_SCOPE_NOT_AUTHORIZED'});expect(collect).not.toHaveBeenCalled();
    config.automation.scopes[0].round=32;config.automation.scopes[0].generation='3';
    expect(await scheduler.tick()).toMatchObject({error:'AUTOMATION_REFERENCE_CHANGED'});expect(collect).not.toHaveBeenCalled();
  });
  it('revocation and expiry prevent further HTTP before any scope discovery',async()=>{
    config.approved=false;expect(()=>scheduler.onModuleInit()).toThrow('AUTOMATION_APPROVAL_REQUIRED');
    expect(await scheduler.tick()).toMatchObject({error:'AUTOMATION_APPROVAL_REQUIRED'});expect(source.get).not.toHaveBeenCalled();
    config.approved=true;config.expiresAt=new Date(0).toISOString();expect(await scheduler.tick()).toMatchObject({error:'AUTOMATION_APPROVAL_REQUIRED'});expect(source.get).not.toHaveBeenCalled();
  });
  it('refuses another server and production without calling official HTTP',async()=>{
    db.$queryRaw.mockResolvedValue([{name:config.schema,server:'different',port:3306}]);
    expect(await scheduler.tick()).toMatchObject({error:'AUTOMATION_SERVER_MISMATCH'});expect(source.get).not.toHaveBeenCalled();
    const old=process.env.NODE_ENV;try{process.env.NODE_ENV='production';expect(await scheduler.tick()).toMatchObject({error:'ADMISSION_LOCAL_ENVIRONMENT_FORBIDDEN'});expect(source.get).not.toHaveBeenCalled();}finally{process.env.NODE_ENV=old;}
  });
});
