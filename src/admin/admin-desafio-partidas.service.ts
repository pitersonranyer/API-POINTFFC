import { BadGatewayException, BadRequestException, ConflictException, GatewayTimeoutException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Desafio, DesafioPartida, DesafioPartidaStatus, DesafioStatus, Prisma } from '@prisma/client';
import { FootballDataClient } from '../futebol/football-data.client';
import { DesafioFixture, FootballDataError } from '../futebol/football-data.normalizer';
import { PrismaService } from '../prisma/prisma.service';
import { PesquisarAdminFixturesDto } from './dto/admin-desafio-partidas.dto';
import { periodoDasPartidas } from '../desafios/desafio-periodo';

export interface PublicacaoPartidas {
  partidas: DesafioPartida[];
  fixtures: Map<number, DesafioFixture>;
}

const ordenacao = [{ ordem: 'asc' as const }, { id: 'asc' as const }];

function mapear(partida: DesafioPartida) {
  return { ...partida, dataInicio: partida.dataInicio.toISOString(),
    criadoEm: partida.criadoEm.toISOString(), atualizadoEm: partida.atualizadoEm.toISOString() };
}

function validarFutura(fixture: DesafioFixture): void {
  if (fixture.statusInterno !== DesafioPartidaStatus.AGENDADA || !fixture.horarioConfirmado) {
    throw new BadRequestException(`Fixture ${fixture.fixtureId} nao esta em situacao aceitavel para um desafio futuro.`);
  }
  if (!Number.isFinite(Date.parse(fixture.dataHoraInicio)) || Date.parse(fixture.dataHoraInicio) <= Date.now()) {
    throw new BadRequestException(`Fixture ${fixture.fixtureId} ja comecou ou nao possui horario futuro valido.`);
  }
}

function snapshot(fixture: DesafioFixture) {
  return {
    fixtureIdApiFootball: fixture.fixtureId, leagueIdApiFootball: fixture.leagueId, nomeCompeticao: fixture.leagueNome,
    mandanteIdApiFootball: fixture.mandanteId, nomeMandante: fixture.mandanteNome, logoMandanteUrl: fixture.mandanteLogo,
    visitanteIdApiFootball: fixture.visitanteId, nomeVisitante: fixture.visitanteNome, logoVisitanteUrl: fixture.visitanteLogo,
    dataInicio: new Date(fixture.dataHoraInicio),
  };
}

function exigirRascunho(desafio: Pick<Desafio, 'status'>): void {
  if (desafio.status !== DesafioStatus.RASCUNHO) throw new ConflictException('Partidas so podem ser alteradas em RASCUNHO.');
}

@Injectable()
export class AdminDesafioPartidasService {
  constructor(private readonly prisma: PrismaService, private readonly footballData: FootballDataClient) {}

  private async consultar<T>(acao: () => Promise<T>): Promise<T> {
    try { return await acao(); } catch (error) {
      if (!(error instanceof FootballDataError)) throw error;
      if (error.code === 'INVALID_QUERY') throw new BadRequestException(error.message);
      if (error.code === 'TIMEOUT') throw new GatewayTimeoutException(error.message);
      if (['NOT_CONFIGURED', 'ACCESS_DENIED', 'RATE_LIMIT', 'UNAVAILABLE'].includes(error.code)) {
        throw new ServiceUnavailableException(error.message);
      }
      throw new BadGatewayException(error.message);
    }
  }

  pesquisar(query: PesquisarAdminFixturesDto): Promise<DesafioFixture[]> {
    return this.consultar(() => this.footballData.pesquisarPartidasPorPeriodo(query.dataInicial, query.dataFinal));
  }

  async listar(id: number) {
    const desafio = await this.prisma.desafio.findUnique({ where: { id }, select: { id: true } });
    if (!desafio) throw new NotFoundException('Desafio nao encontrado.');
    const rows = await this.prisma.desafioPartida.findMany({ where: { desafioId: id }, orderBy: ordenacao });
    return rows.map(mapear);
  }

  async adicionar(id: number, fixtureId: number) {
    // Evita consumo externo em erros internos previsiveis; todas as verificacoes sao repetidas sob lock.
    const desafio = await this.prisma.desafio.findUnique({ where: { id }, select: { status: true } });
    if (!desafio) throw new NotFoundException('Desafio nao encontrado.');
    exigirRascunho(desafio);
    await this.exigirNaoDuplicada(this.prisma, id, fixtureId);
    const [fixture] = await this.consultar(() => this.footballData.buscarPartidasPorIds([fixtureId]));
    if (!fixture) throw new NotFoundException(`Fixture ${fixtureId} nao encontrada na football-data.org.`);
    if (fixture.fixtureId !== fixtureId) throw new BadGatewayException('football-data.org retornou fixture divergente.');
    validarFutura(fixture);
    try {
      return await this.comRascunho(id, async tx => {
        await this.exigirNaoDuplicada(tx, id, fixtureId);
        validarFutura(fixture);
        const ultima = await tx.desafioPartida.findFirst({ where: { desafioId: id }, orderBy: { ordem: 'desc' }, select: { ordem: true } });
        const ordem = (ultima?.ordem ?? 0) + 1;
        if (ordem > 4294967295) throw new ConflictException('Limite de ordem das partidas atingido.');
        const criada = await tx.desafioPartida.create({ data: {
          desafioId: id, ...snapshot(fixture), ordem, status: DesafioPartidaStatus.AGENDADA,
          resultado: null, golsMandante: null, golsVisitante: null,
        } });
        await this.recalcularPeriodo(tx, id);
        return mapear(criada);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Fixture ja adicionada a este Desafio.');
      }
      throw error;
    }
  }

  async remover(id: number, partidaId: number) {
    try {
      return await this.comRascunho(id, async tx => {
        const partida = await tx.desafioPartida.findFirst({ where: { id: partidaId, desafioId: id } });
        if (!partida) throw new NotFoundException('Partida nao encontrada neste Desafio.');
        // Nao remove palpites de desenvolvimento nem contorna a FK restritiva da Etapa 1.
        if (await tx.desafioPalpite.count({ where: { desafioPartidaId: partidaId } })) {
          throw new ConflictException('Partida possui palpites relacionados e nao pode ser removida.');
        }
        await tx.desafioPartida.delete({ where: { id: partidaId } });
        const restantes = await tx.desafioPartida.findMany({ where: { desafioId: id }, orderBy: ordenacao });
        await tx.desafio.update({ where: { id }, data: periodoDasPartidas(restantes) });
        return this.gravarOrdem(tx, restantes.map(partida => partida.id));
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new ConflictException('Partida possui registros relacionados e nao pode ser removida.');
      }
      throw error;
    }
  }

  reordenar(id: number, partidaIds: number[]) {
    return this.comRascunho(id, async tx => {
      const atuais = await tx.desafioPartida.findMany({ where: { desafioId: id }, orderBy: ordenacao });
      const ids = new Set(atuais.map(partida => partida.id));
      if (new Set(partidaIds).size !== partidaIds.length || partidaIds.length !== atuais.length || partidaIds.some(partidaId => !ids.has(partidaId))) {
        throw new BadRequestException('Informe todas as partidas deste Desafio uma unica vez, sem partidas externas.');
      }
      return this.gravarOrdem(tx, partidaIds);
    });
  }

  async prepararPublicacao(id: number): Promise<PublicacaoPartidas> {
    const partidas = await this.prisma.desafioPartida.findMany({ where: { desafioId: id }, orderBy: ordenacao });
    if (!partidas.length) throw new BadRequestException('Desafio precisa de pelo menos uma partida valida para publicar.');
    const fixtures = await this.consultar(() => this.footballData.buscarPartidasPorIds(partidas.map(partida => partida.fixtureIdApiFootball)));
    const porId = new Map(fixtures.map(fixture => [fixture.fixtureId, fixture]));
    for (const partida of partidas) {
      if (!porId.has(partida.fixtureIdApiFootball)) throw new NotFoundException(`Fixture ${partida.fixtureIdApiFootball} nao encontrada na football-data.org.`);
    }
    return { partidas, fixtures: porId };
  }

  async aplicarPublicacao(tx: Prisma.TransactionClient, desafio: Pick<Desafio, 'id'>, preparacao: PublicacaoPartidas) {
    // Chamado somente dentro da transacao que ja detem o lock de DESAFIO.
    const atuais = await tx.desafioPartida.findMany({ where: { desafioId: desafio.id }, orderBy: ordenacao });
    const antes = preparacao.partidas;
    if (atuais.length !== antes.length || atuais.some((partida, indice) => {
      const original = antes[indice];
      return partida.id !== original.id || partida.fixtureIdApiFootball !== original.fixtureIdApiFootball || partida.ordem !== original.ordem;
    })) throw new ConflictException('Composicao das partidas mudou durante a consulta. Tente publicar novamente.');
    if (!atuais.length) throw new BadRequestException('Desafio precisa de pelo menos uma partida valida para publicar.');
    const atualizacoes = atuais.map(partida => {
      const fixture = preparacao.fixtures.get(partida.fixtureIdApiFootball);
      if (!fixture) throw new NotFoundException(`Fixture ${partida.fixtureIdApiFootball} nao encontrada na football-data.org.`);
      if (fixture.fixtureId !== partida.fixtureIdApiFootball || fixture.leagueId !== partida.leagueIdApiFootball
        || fixture.mandanteId !== partida.mandanteIdApiFootball || fixture.visitanteId !== partida.visitanteIdApiFootball) {
        throw new ConflictException(`Identidade oficial da fixture ${partida.fixtureIdApiFootball} diverge do snapshot.`);
      }
      if (partida.status !== DesafioPartidaStatus.AGENDADA || partida.resultado !== null
        || partida.golsMandante !== null || partida.golsVisitante !== null) {
        throw new BadRequestException(`Partida ${partida.id} nao esta em situacao aceitavel para publicar.`);
      }
      validarFutura(fixture);
      return { id: partida.id, fixture };
    });
    // Valida o conjunto inteiro antes de atualizar qualquer snapshot; rollback inclui a publicacao.
    for (const { id, fixture } of atualizacoes) await tx.desafioPartida.update({ where: { id }, data: snapshot(fixture) });
    for (const { fixture } of atualizacoes) validarFutura(fixture);
    return periodoDasPartidas(atualizacoes.map(({ fixture }) => ({ dataInicio: new Date(fixture.dataHoraInicio) })));
  }

  async recalcularPeriodo(tx: Prisma.TransactionClient, id: number) {
    const partidas = await tx.desafioPartida.findMany({ where: { desafioId: id } });
    const periodo = periodoDasPartidas(partidas);
    await tx.desafio.update({ where: { id }, data: periodo });
    return periodo;
  }

  private async exigirNaoDuplicada(client: Pick<Prisma.TransactionClient, 'desafioPartida'>, desafioId: number, fixtureIdApiFootball: number): Promise<void> {
    if (await client.desafioPartida.findUnique({ where: { desafioId_fixtureIdApiFootball: { desafioId, fixtureIdApiFootball } } })) {
      throw new ConflictException('Fixture ja adicionada a este Desafio.');
    }
  }

  private async gravarOrdem(tx: Prisma.TransactionClient, ids: number[]) {
    const result = [];
    for (const [index, id] of ids.entries()) {
      result.push(mapear(await tx.desafioPartida.update({ where: { id }, data: { ordem: index + 1 } })));
    }
    return result;
  }

  private comRascunho<T>(id: number, acao: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      const lock = await tx.$queryRaw<Array<{ ID: number | bigint }>>`SELECT ID FROM DESAFIO WHERE ID = ${id} FOR UPDATE`;
      if (!lock.length) throw new NotFoundException('Desafio nao encontrado.');
      const desafio = await tx.desafio.findUnique({ where: { id }, select: { status: true } });
      if (!desafio) throw new NotFoundException('Desafio nao encontrado.');
      exigirRascunho(desafio);
      return acao(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
