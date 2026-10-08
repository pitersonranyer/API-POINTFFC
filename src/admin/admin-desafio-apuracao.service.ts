import { BadGatewayException, ConflictException, GatewayTimeoutException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DesafioStatus, Prisma } from '@prisma/client';
import { FootballDataClient } from '../futebol/football-data.client';
import { DesafioResultadoOficial } from '../futebol/football-data-desafio-resultado';
import { FootballDataError } from '../futebol/football-data.normalizer';
import { PrismaService } from '../prisma/prisma.service';

const include = { partidas: { orderBy: { id: 'asc' as const } } } satisfies Prisma.DesafioInclude;
export type DesafioApuracao = Prisma.DesafioGetPayload<{ include: typeof include }>;
const permitido = (status: DesafioStatus) => status === 'ABERTO' || status === 'EM_ANDAMENTO' || status === 'ENCERRADO';

@Injectable()
export class AdminDesafioApuracaoService {
  constructor(private readonly prisma: PrismaService, private readonly futebol: FootballDataClient) {}

  async apurar(id: number) {
    const inicial = await this.prisma.desafio.findUnique({ where: { id }, include });
    if (!inicial) throw new NotFoundException('Desafio nao encontrado.');
    this.validar(inicial);
    // Chamadas externas fora da transacao: rate limit do cliente pode aguardar varios segundos.
    let oficiais: DesafioResultadoOficial[];
    try { oficiais = await this.futebol.buscarResultadosPorIds(inicial.partidas.map(p => p.fixtureIdApiFootball)); }
    catch (error) {
      if (!(error instanceof FootballDataError)) throw error;
      if (error.code === 'TIMEOUT') throw new GatewayTimeoutException('Timeout ao consultar resultados oficiais.');
      if (['NOT_CONFIGURED', 'ACCESS_DENIED', 'RATE_LIMIT', 'UNAVAILABLE'].includes(error.code)) {
        throw new ServiceUnavailableException('Resultados oficiais indisponiveis.');
      }
      throw new BadGatewayException('Falha ao consultar resultados oficiais.');
    }
    return this.aplicarResultados(inicial, oficiais);
  }

  async aplicarResultados(inicial: DesafioApuracao, oficiais: DesafioResultadoOficial[], automatico = false) {
    const id = inicial.id;
    this.validar(inicial);
    const porId = new Map(oficiais.map(p => [p.fixtureId, p]));
    if (porId.size !== oficiais.length || (!automatico && (porId.size !== inicial.partidas.length
      || inicial.partidas.some(p => !porId.has(p.fixtureIdApiFootball))))
      || oficiais.some(o => !inicial.partidas.some(p => p.fixtureIdApiFootball === o.fixtureId))) {
      throw new BadGatewayException('Fornecedor nao retornou todas as partidas solicitadas.');
    }

    return this.prisma.$transaction(async tx => {
      const lock = await tx.$queryRaw<Array<{ ID: number | bigint }>>`SELECT ID FROM DESAFIO WHERE ID = ${id} FOR UPDATE`;
      if (!lock.length) throw new NotFoundException('Desafio nao encontrado.');
      const atual = await tx.desafio.findUnique({ where: { id }, include });
      if (!atual) throw new NotFoundException('Desafio nao encontrado.');
      this.validar(atual);
      // Nao sobrescreve apuracao/admin concorrente com uma consulta externa anterior.
      if (JSON.stringify(atual) !== JSON.stringify(inicial)) {
        throw new ConflictException('Desafio alterado durante a consulta; tente apurar novamente.');
      }
      for (const p of atual.partidas) {
        const oficial = porId.get(p.fixtureIdApiFootball);
        if (!oficial) continue;
        if (oficial.leagueId !== p.leagueIdApiFootball || oficial.mandanteId !== p.mandanteIdApiFootball
          || oficial.visitanteId !== p.visitanteIdApiFootball) throw new ConflictException('Identidade oficial da partida diverge do snapshot.');
      }
      const pendencias: Array<{ partidaId: number; motivo: string }> = [];
      let finalizadas = 0;
      let anuladas = 0;
      for (const p of atual.partidas) {
        const oficial = porId.get(p.fixtureIdApiFootball);
        if (!oficial) {
          if (p.status === 'FINALIZADA') finalizadas++;
          if (p.status === 'ANULADA') anuladas++;
          continue;
        }
        await tx.desafioPartida.update({ where: { id: p.id }, data: {
          status: oficial.statusApuracao, dataInicio: new Date(oficial.dataHoraInicio),
          resultado: oficial.resultado, golsMandante: oficial.golsMandante, golsVisitante: oficial.golsVisitante,
        } });
        const where = { desafioId: id, desafioPartidaId: p.id };
        if (oficial.statusApuracao === 'FINALIZADA' && oficial.resultado !== null) {
          finalizadas++;
          // Atribuicao absoluta, nunca incremento: permite repeticao e correcao oficial.
          await tx.desafioPalpite.updateMany({ where, data: { pontos: new Prisma.Decimal(0), apurado: true } });
          await tx.desafioPalpite.updateMany({ where: { ...where, palpite: oficial.resultado }, data: { pontos: new Prisma.Decimal(1), apurado: true } });
        } else {
          if (oficial.statusApuracao === 'ANULADA') anuladas++;
          // Pendentes/anuladas nao pontuam; tambem remove pontos de resultado revogado.
          await tx.desafioPalpite.updateMany({ where, data: { pontos: null, apurado: false } });
        }
        if (oficial.pendencia) pendencias.push({ partidaId: p.id, motivo: oficial.pendencia });
      }
      const resolvidas = finalizadas + anuladas;
      const emCurso = atual.status !== 'ABERTO' || new Date() >= atual.dataInicio || oficiais.some(p =>
        p.statusApuracao === 'EM_ANDAMENTO' || p.statusApuracao === 'FINALIZADA');
      const status: DesafioStatus = resolvidas === atual.partidas.length ? 'ENCERRADO' : emCurso ? 'EM_ANDAMENTO' : 'ABERTO';
      await tx.desafio.update({ where: { id }, data: { status } });
      return { desafioId: id, status, totalPartidas: atual.partidas.length, partidasApuradas: finalizadas,
        partidasAnuladas: anuladas, partidasPendentes: atual.partidas.length - resolvidas, pendencias };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 });
  }

  private validar(desafio: DesafioApuracao): void {
    if (!permitido(desafio.status) || !desafio.publicadoEm || desafio.publicadoEm > new Date()) {
      throw new ConflictException('Somente Desafio publicado e nao cancelado permite apuracao.');
    }
    if (!desafio.partidas.length) throw new ConflictException('Desafio sem partidas nao pode ser apurado.');
  }
}
