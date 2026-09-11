import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FutebolSyncService } from './futebol-sync.service';
import { futebolSyncDecision, FUTEBOL_TIMEZONE } from './futebol-sync-policy';

@Injectable()
export class FutebolSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FutebolSchedulerService.name);
  private running = false;
  private retryAfter = 0;
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService,
    private readonly sync: FutebolSyncService) {}

  onApplicationBootstrap() {
    // Initial load must not delay HTTP readiness or reject application startup.
    void this.evaluate();
  }

  @Cron('0 */5 * * * *', { timeZone: FUTEBOL_TIMEZONE })
  async evaluate() {
    const enabled = this.config.get<boolean | string>('FUTEBOL_SYNC_SCHEDULER_ENABLED');
    if ((enabled !== true && enabled !== 'true') || this.running) return;
    this.running = true;
    let retryInterval = 5 * 60_000;
    try {
      const now = new Date();
      if (now.getTime() < this.retryAfter) return;
      const competition = await this.prisma.futebolCompeticao.findUnique({ where: { codigo: 'BSA' },
        select: { id: true, temporadaAtual: true, ultimoSyncEm: true } });
      const matches = competition ? await this.prisma.futebolPartida.findMany({
        where: { competicaoId: competition.id, temporada: competition.temporadaAtual },
        select: { dataHoraUtc: true, status: true },
      }) : [];
      const decision = futebolSyncDecision(now, competition?.ultimoSyncEm ?? null, matches);
      if (!decision.due) return;
      retryInterval = decision.interval;
      this.logger.log(`BSA sync iniciado: ${decision.reason}`);
      const result = await this.sync.syncBrasileirao();
      this.retryAfter = 0;
      this.logger.log(`BSA sync concluido: ${JSON.stringify(result, ['competicao', 'temporada', 'clubesProcessados', 'partidasRecebidas', 'partidasPersistidas'])}`);
    } catch {
      this.retryAfter = Date.now() + retryInterval;
      this.logger.warn('BSA sync falhou; nova tentativa automatica posterior. Verifique provedor, token, banco e migrations.');
    } finally {
      // In-process only; not a distributed lock.
      this.running = false;
    }
  }
}
