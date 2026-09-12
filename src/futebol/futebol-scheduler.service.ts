import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FutebolSyncService } from './futebol-sync.service';
import { futebolSyncDecision, FUTEBOL_TIMEZONE } from './futebol-sync-policy';
import { FootballDataError } from './football-data.normalizer';

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
    this.logger.log(JSON.stringify({ event: 'futebol.tick', at: new Date().toISOString(), pid: process.pid,
      enabled: enabled === true || enabled === 'true', running: this.running, retryAfter: this.retryAfter ? new Date(this.retryAfter).toISOString() : null }));
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
      this.logger.log(JSON.stringify({ event: 'futebol.decision', at: now.toISOString(), ...decision,
        ultimoSyncEm: competition?.ultimoSyncEm ?? null, partidas: matches.length }));
      if (!decision.due) return;
      retryInterval = decision.interval;
      this.logger.log(`BSA sync iniciado: ${decision.reason}`);
      const result = await this.sync.syncBrasileirao();
      this.retryAfter = 0;
      this.logger.log(`BSA sync concluido: ${JSON.stringify(result, ['competicao', 'temporada', 'clubesProcessados', 'partidasRecebidas', 'partidasPersistidas'])}`);
    } catch (error) {
      this.retryAfter = Date.now() + retryInterval;
      // Provider errors are sanitized by the client/normalizer. Never log raw
      // database errors: they may contain connection details or query values.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const reason = error instanceof FootballDataError ? error.message
        : code === 'P2022' ? 'Coluna ausente no banco. Aplique as migrations pendentes com prisma migrate deploy (incluindo 0016_futebol_ultimo_sync).'
        : code === 'P2021' ? 'Tabela ausente no banco. Aplique as migrations pendentes com prisma migrate deploy.'
        : typeof code === 'string' && /^P\d{4}$/.test(code) ? `Falha no banco (${code}).`
        : 'Falha interna; verifique a conexao com o banco e as migrations.';
      this.logger.warn(`BSA sync falhou: ${reason} Nova tentativa a partir de ${new Date(this.retryAfter).toISOString()}.`);
    } finally {
      // In-process only; not a distributed lock.
      this.running = false;
    }
  }
}
