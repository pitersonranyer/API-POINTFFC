import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DesafioPartida } from '@prisma/client';
import { AdminDesafioApuracaoService } from '../admin/admin-desafio-apuracao.service';
import { FootballDataClient } from '../futebol/football-data.client';
import { FootballDataError } from '../futebol/football-data.normalizer';
import { PrismaService } from '../prisma/prisma.service';
import { resultadoInterno, resultadoInternoInclude } from './desafio-resultado-interno';
import { DesafioResultadoOficial } from '../futebol/football-data-desafio-resultado';

@Injectable()
export class DesafioSyncService {
  private readonly logger = new Logger(DesafioSyncService.name);
  private running = false;
  private retryAt = 0;

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService,
    private readonly futebol: FootballDataClient, private readonly apuracao: AdminDesafioApuracaoService) {}

  private devida(p: DesafioPartida, now: number) {
    if (!['AGENDADA', 'EM_ANDAMENTO'].includes(p.status) || p.dataInicio.getTime() > now + 15 * 60_000) return false;
    const intervalo = p.dataInicio.getTime() < now - 6 * 3600_000 ? 3600_000 : 5 * 60_000;
    return p.atualizadoEm.getTime() <= now - intervalo;
  }

  @Cron('0 */5 * * * *', { timeZone: 'America/Sao_Paulo' })
  async evaluate() {
    const enabled = this.config.get<boolean | string>('DESAFIOS_SYNC_SCHEDULER_ENABLED');
    if ((enabled !== true && enabled !== 'true') || this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const desafios = await this.prisma.desafio.findMany({
        where: { status: { in: ['ABERTO', 'EM_ANDAMENTO', 'ENCERRADO'] }, publicadoEm: { lte: new Date(now) },
          partidas: { some: { status: { in: ['AGENDADA', 'EM_ANDAMENTO'] }, dataInicio: { lte: new Date(now + 15 * 60_000) } } } },
        include: { partidas: { orderBy: { id: 'asc' } } },
      });
      const trabalhos = desafios.map(snapshot => ({ snapshot, partidas: snapshot.partidas.filter(p => this.devida(p, now)) }))
        .filter(t => t.partidas.length);
      const ids = [...new Set(trabalhos.flatMap(t => t.partidas.map(p => p.fixtureIdApiFootball)))];
      if (!ids.length) return;
      const internas = await this.prisma.futebolPartida.findMany({ where: { externalId: { in: ids } }, include: resultadoInternoInclude });
      const porId = new Map<number, DesafioResultadoOficial>();
      for (const partida of internas) {
        const snapshots = trabalhos.flatMap(t => t.partidas).filter(p => p.fixtureIdApiFootball === partida.externalId);
        const resultado = resultadoInterno(partida, snapshots, now);
        if (resultado) porId.set(partida.externalId, resultado);
      }
      const internos = porId.size;
      const externos = ids.filter(id => !porId.has(id));
      if (externos.length && now >= this.retryAt) {
        try {
          const oficiais = await this.futebol.buscarResultadosPorIds(externos);
          if (new Set(oficiais.map(o => o.fixtureId)).size !== oficiais.length
            || oficiais.some(o => !externos.includes(o.fixtureId))) throw new Error('INVALID_BATCH');
          for (const oficial of oficiais) porId.set(oficial.fixtureId, oficial);
          this.retryAt = 0;
        } catch (error) { this.registrarFalha(error); }
      }
      this.logger.log(JSON.stringify({ event: 'desafios.sync.sources', ids: ids.length, internos,
        fallback: externos.length, disponiveis: porId.size }));
      for (const { snapshot, partidas } of trabalhos) {
        try {
          const disponiveis = partidas.filter(p => porId.has(p.fixtureIdApiFootball));
          if (disponiveis.length < partidas.length) this.logger.warn(JSON.stringify({ event: 'desafios.sync.pending',
            desafioId: snapshot.id, semResultado: partidas.length - disponiveis.length }));
          if (!disponiveis.length) continue;
          const result = await this.apuracao.aplicarResultados(snapshot, disponiveis.map(p => porId.get(p.fixtureIdApiFootball)!), true);
          this.logger.log(JSON.stringify({ event: 'desafios.sync.ok', ...result, consultadas: disponiveis.length }));
        } catch {
          this.logger.warn(JSON.stringify({ event: 'desafios.sync.skipped', desafioId: snapshot.id,
            reason: 'Resposta incompleta, snapshot alterado ou falha transacional; nova tentativa no proximo ciclo.' }));
        }
      }
    } catch (error) {
      this.registrarFalha(error);
    } finally { this.running = false; }
  }

  private registrarFalha(error: unknown) {
    this.retryAt = Date.now() + (error instanceof FootballDataError && ['RATE_LIMIT', 'ACCESS_DENIED', 'NOT_CONFIGURED'].includes(error.code)
        ? 15 * 60_000 : 5 * 60_000);
    this.logger.warn(JSON.stringify({ event: 'desafios.sync.failed', code: error instanceof FootballDataError ? error.code : 'INTERNAL',
        retryAt: new Date(this.retryAt).toISOString() }));
  }
}
