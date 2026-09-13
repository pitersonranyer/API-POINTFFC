import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FutebolSyncService } from './futebol-sync.service';
import { futebolSyncDecision, FUTEBOL_TIMEZONE } from './futebol-sync-policy';
import { FootballDataError } from './football-data.normalizer';
import { FUTEBOL_COMPETICOES, FutebolCodigo } from './futebol-competicoes';

@Injectable()
export class FutebolSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FutebolSchedulerService.name);
  private running = false;
  private readonly retryAfter = new Map<FutebolCodigo, number>();
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
      enabled: enabled === true || enabled === 'true', running: this.running }));
    if ((enabled !== true && enabled !== 'true') || this.running) return;
    this.running = true;
    try {
      const now = new Date();
      for (const code of FUTEBOL_COMPETICOES) {
        if (now.getTime() < (this.retryAfter.get(code) ?? 0)) continue;
        let retryInterval = 5 * 60_000;
        try {
          const competition = await this.prisma.futebolCompeticao.findUnique({ where: { codigo: code },
            select: { id: true, temporadaAtual: true, ultimoSyncEm: true } });
          const matches = competition ? await this.prisma.futebolPartida.findMany({
            where: { competicaoId: competition.id, temporada: competition.temporadaAtual },
            select: { dataHoraUtc: true, status: true },
          }) : [];
          const decision = futebolSyncDecision(now, competition?.ultimoSyncEm ?? null, matches);
          this.logger.log(JSON.stringify({ event: 'futebol.decision', codigo: code, at: now.toISOString(), ...decision,
            ultimoSyncEm: competition?.ultimoSyncEm ?? null, partidas: matches.length }));
          if (!decision.due) continue;
          retryInterval = decision.interval;
          this.logger.log(`${code} sync iniciado: ${decision.reason}`);
          const result = code === 'BSA' ? await this.sync.syncBrasileirao() : await this.sync.syncCompeticao(code);
          this.retryAfter.delete(code);
          this.logger.log(`${code} sync concluido: ${JSON.stringify(result, ['competicao', 'temporada', 'clubesProcessados', 'partidasRecebidas', 'partidasPersistidas'])}`);
        } catch (error) {
          const retryAfter = Date.now() + retryInterval;
          this.retryAfter.set(code, retryAfter);
          // Provider errors are sanitized by the client/normalizer. Never log raw
          // database errors: they may contain connection details or query values.
          const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          const reason = error instanceof FootballDataError ? error.message
            : errorCode === 'P2022' ? 'Coluna ausente no banco. Aplique as migrations pendentes com prisma migrate deploy (incluindo 0016_futebol_ultimo_sync).'
            : errorCode === 'P2021' ? 'Tabela ausente no banco. Aplique as migrations pendentes com prisma migrate deploy.'
            : typeof errorCode === 'string' && /^P\d{4}$/.test(errorCode) ? `Falha no banco (${errorCode}).`
            : 'Falha interna; verifique a conexao com o banco e as migrations.';
          this.logger.warn(`${code} sync falhou: ${reason} Nova tentativa a partir de ${new Date(retryAfter).toISOString()}.`);
        }
      }
    } finally {
      // In-process only; not a distributed lock.
      this.running = false;
    }
  }
}
