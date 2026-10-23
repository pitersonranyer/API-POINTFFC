import { DynamicModule, Inject, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CartolaObservationSource } from './observation-source';
import { CurrentScoringService } from './current-scoring.service';
import { market } from './observation.service';
import { partialScoringPolicy } from './current-scoring-policy';
import { authorizeLocalScoring, LocalScoringApproval, localScoringDestination, prepareLocalScoringApproval } from './local-scoring-authorization';
import { ObservationError } from './official-normalizer';

export interface LocalAutomationApproval extends LocalScoringApproval {
  automation: { intervalMs: number; scopes: Array<{ season: number; round: number; generation: string }>; historicalTest?: { season: number; round: number } };
}
const OPTIONS = 'POINT_FANTASY_LOCAL_AUTOMATION_OPTIONS';
@Injectable()
export class LocalScoringScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocalScoringScheduler.name);
  private active?: Promise<Record<string, unknown>>;
  private stopping = false;
  constructor(@Inject(OPTIONS) private readonly options: { file: string; url: string }, private readonly db: PrismaService,
    private readonly registry: SchedulerRegistry, private readonly source: CartolaObservationSource) {}
  private config(): LocalAutomationApproval {
    const u = localScoringDestination(this.options.url,true);
    const c = JSON.parse(readFileSync(this.options.file,'utf8')) as LocalAutomationApproval;
    if (c.approved !== true || !c.operator?.trim() || !c.reason?.trim() || c.policy !== 'partial-v1' || c.review
      || c.host !== '127.0.0.1' || c.port !== 3306 || c.schema !== u.pathname.slice(1) || Date.parse(c.expiresAt) <= Date.now()
      || !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) > Date.now()+86400000
      || !c.automation?.scopes?.length || !Number.isInteger(c.automation.intervalMs) || c.automation.intervalMs < 1000 || c.automation.intervalMs > 86400000
      || c.automation.scopes.some(s=>!Number.isInteger(s.season)||s.season<2000||s.season>65535||!Number.isInteger(s.round)||s.round<1||s.round>38||!/^\d+$/.test(s.generation))) {
      throw new ObservationError('AUTOMATION_APPROVAL_REQUIRED');
    }
    const test = c.automation.historicalTest;
    if (test && (test.season !== c.season || test.round !== c.round
      || !c.automation.scopes.some(s => s.season === test.season && s.round === test.round && s.generation === c.generation))) {
      throw new ObservationError('AUTOMATION_SCOPE_NOT_AUTHORIZED');
    }
    return c;
  }
  onModuleInit() {
    const config = this.config();
    this.registry.addInterval('point-fantasy-current',setInterval(()=>{void this.tick();},config.automation.intervalMs));
    this.logger.log({ event:'automation.started',intervalMs:config.automation.intervalMs,operator:config.operator });
  }
  tick(): Promise<Record<string, unknown>> {
    if (this.stopping || this.active) return Promise.resolve({ event:'automation.skipped',reason:'RUNNING_OR_STOPPING' });
    this.active = this.execute().finally(()=>{this.active=undefined;}); return this.active;
  }
  private async execute(): Promise<Record<string, unknown>> {
    let operationId: string | undefined;
    let operator: string | undefined, reason: string | undefined, marketHttpStatus: number | null | undefined;
    try {
      const c = this.config();
      operator=c.operator;reason=c.reason;
      const [identity] = await this.db.$queryRaw<Array<{name:string;server:string;port:number|bigint}>>`SELECT DATABASE() AS name,@@server_uuid AS server,@@port AS port`;
      if(identity.name!==c.schema||identity.server!==c.server||Number(identity.port)!==3306)throw new ObservationError('AUTOMATION_SERVER_MISMATCH');
      const response=await this.source.get('/mercado/status');marketHttpStatus=response.status;
      const context = market(response);
      if(!context)throw new ObservationError('AUTOMATION_MARKET_UNAVAILABLE');
      const test = c.automation.historicalTest;
      if (!test && context.status_mercado !== 2) {
        const event = { event:'automation.skipped',reason:'MARKET_NOT_CLOSED',marketHttpStatus };
        this.logger.log(event);return event;
      }
      const selected = test ?? { season:context.temporada,round:context.rodada_atual };
      const scope = c.automation.scopes.find(s=>s.season===selected.season&&s.round===selected.round);
      if(!scope)throw new ObservationError('AUTOMATION_SCOPE_NOT_AUTHORIZED');
      operationId=randomUUID();
      const draft=await prepareLocalScoringApproval(this.db,this.options.url,scope.season,scope.round,operationId);
      if(draft.server!==c.server||draft.generation!==scope.generation||draft.schemaSignature!==c.schemaSignature
        || Object.entries(draft.migrations).some(([name,hash])=>c.migrations[name as keyof typeof c.migrations]!==hash))throw new ObservationError('AUTOMATION_REFERENCE_CHANGED');
      const approval={...draft,approved:true,operator:c.operator,reason:c.reason,expiresAt:new Date(Math.min(Date.parse(draft.expiresAt),Date.parse(c.expiresAt))).toISOString()};
      const auth=await authorizeLocalScoring(this.db,this.options.url,approval);
      const result=await new CurrentScoringService(this.db,this.source,this.options.url,partialScoringPolicy,auth).collect(scope.season,scope.round,operationId);
      const event={event:'automation.result',operator:c.operator,reason:c.reason,season:scope.season,round:scope.round,...result};
      this.logger.log(event);return event;
    } catch(error) {
      const event={event:'automation.failed',operationId,operator,reason,marketHttpStatus,error:error instanceof ObservationError?error.code:'AUTOMATION_EXECUTION_FAILED'};
      this.logger.warn(event);return event;
    }
  }
  async stop() {
    this.stopping=true;
    if(this.registry.doesExist('interval','point-fantasy-current'))this.registry.deleteInterval('point-fantasy-current');
    await this.active;
  }
  async onModuleDestroy(){await this.stop();}
}
// Separate context: never imports AppModule or traditional/financial schedulers.
@Module({})
export class LocalScoringAutomationModule {
  static configure(file:string,url:string):DynamicModule {
    localScoringDestination(url,true);
    return {module:LocalScoringAutomationModule,imports:[ScheduleModule.forRoot()],providers:[
      {provide:OPTIONS,useValue:{file,url}},
      {provide:PrismaService,useFactory:()=>new PrismaService({datasources:{db:{url}}})},
      CartolaObservationSource,LocalScoringScheduler,
    ]};
  }
}
