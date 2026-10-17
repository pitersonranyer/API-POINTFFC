import { BadGatewayException, BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../cartola/cartola.service';
import { CartolaMarketStatus } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';
import { CaptureCatalogDto, CreateFantasyCompetitionDto, FantasyPageDto } from './point-fantasy.dto';
import { CatalogReferences, classifyAthlete, SnapshotMatch } from './point-fantasy.rules';
import { LineupPageDto } from './lineups/lineup.dto';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadGatewayException('Objeto Cartola invalido');
  return value as Record<string, unknown>;
}
function uint(value: unknown, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 4294967295) {
    throw new BadGatewayException('Identificador Cartola invalido');
  }
  return value;
}

@Injectable()
export class PointFantasyService {
  constructor(private readonly prisma: PrismaService, private readonly cartola: CartolaService) {}

  private validateMarket(status: CartolaMarketStatus, dto: Pick<CaptureCatalogDto, 'temporada' | 'rodada'>) {
    if (status.temporada !== dto.temporada || status.rodada_atual !== dto.rodada
      || status.status_mercado !== 1 || status.bola_rolando !== false || status.game_over === true) {
      throw new ConflictException('Captura exige mercado aberto, temporada e rodada oficiais correspondentes');
    }
  }

  private async atomic<T>(action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        throw new ConflictException('Operacao concorrente: repita a solicitacao com os mesmos parametros');
      }
      throw error;
    }
  }

  async capture(dto: CaptureCatalogDto) {
    const where = { temporada_rodada_versao: dto };
    const previous = await this.prisma.fantasyCatalogo.findUnique({ where });
    if (previous) return previous;
    this.validateMarket(await this.cartola.loadMarketStatusFresh(), dto);
    const [raw, rawMatches] = await Promise.all([
      this.cartola.loadMarketAthletesFresh(), this.cartola.loadMatchesFresh(dto.rodada),
    ]);
    const payload = record(raw);
    const matches = record(rawMatches);
    const clubes = record(payload.clubes);
    const posicoes = record(payload.posicoes);
    // Position 6 is the Cartola coach; reject a changed provider dictionary.
    const coach = record(posicoes['6']);
    if (coach.abreviacao !== 'tec') throw new BadGatewayException('Dicionario de posicoes Cartola inesperado');
    if (!Array.isArray(payload.atletas) || !payload.atletas.length || matches.rodada !== dto.rodada
      || !Array.isArray(matches.partidas) || !matches.partidas.length) throw new BadGatewayException('Snapshot Cartola incompleto');
    const ids = new Set<number>();
    const athletes = payload.atletas.map(value => {
      const a = record(value);
      const atletaIdExterno = uint(a.atleta_id);
      const clubeIdExterno = uint(a.clube_id);
      const posicaoId = uint(a.posicao_id);
      if (ids.has(atletaIdExterno) || !clubes[String(clubeIdExterno)] || !posicoes[String(posicaoId)]
        || posicaoId > 6 || typeof a.apelido !== 'string' || !a.apelido.trim() || a.apelido.length > 255
        || typeof a.preco_num !== 'number' || !Number.isFinite(a.preco_num)) throw new BadGatewayException('Atleta Cartola invalido');
      ids.add(atletaIdExterno);
      const precoCartola = new Prisma.Decimal(a.preco_num);
      return { atletaIdExterno, clubeIdExterno, posicaoId, statusId: uint(a.status_id, true),
        apelido: a.apelido, precoCartola, ...classifyAthlete(precoCartola, posicaoId) };
    });
    const matchIds = new Set<number>();
    const partidas: SnapshotMatch[] = matches.partidas.map(value => {
      const m = record(value);
      const partidaIdExterno = uint(m.partida_id);
      const clubeMandanteId = uint(m.clube_casa_id);
      const clubeVisitanteId = uint(m.clube_visitante_id);
      // Cartola timestamp is epoch seconds. Never interpret partida_data in the host timezone.
      const date = new Date(typeof m.timestamp === 'number' ? m.timestamp * 1000 : NaN);
      if (matchIds.has(partidaIdExterno) || clubeMandanteId === clubeVisitanteId
        || !clubes[String(clubeMandanteId)] || !clubes[String(clubeVisitanteId)] || !Number.isFinite(date.getTime())
        || date.getUTCFullYear() !== dto.temporada) throw new BadGatewayException('Partida Cartola invalida');
      matchIds.add(partidaIdExterno);
      return { partidaIdExterno, clubeMandanteId, clubeVisitanteId, inicioPrevisto: date.toISOString() };
    });
    this.validateMarket(await this.cartola.loadMarketStatusFresh(), dto);
    const referencias = { clubes, posicoes, partidas } as unknown as Prisma.InputJsonValue;
    return this.atomic(async tx => {
      const existing = await tx.fantasyCatalogo.findUnique({ where });
      if (existing) return existing;
      return tx.fantasyCatalogo.create({ data: { ...dto, capturadoEm: new Date(), referencias,
        atletas: { create: athletes } } });
    });
  }

  async catalogs(page: FantasyPageDto) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.fantasyCatalogo.findMany({ skip: (page.page - 1) * page.limit, take: page.limit,
        orderBy: [{ temporada: 'desc' }, { rodada: 'desc' }, { versao: 'desc' }],
        select: { id: true, temporada: true, rodada: true, versao: true, status: true, capturadoEm: true, congeladoEm: true, criadoEm: true } }),
      this.prisma.fantasyCatalogo.count(),
    ]);
    return { items, total, page: page.page, limit: page.limit };
  }

  private async catalog(id: number, db: Prisma.TransactionClient = this.prisma) {
    const catalog = await db.fantasyCatalogo.findUnique({ where: { id } });
    if (!catalog) throw new NotFoundException('Catalogo Fantasy nao encontrado');
    return catalog;
  }

  async athletes(catalogoId: number, page: FantasyPageDto, clubs?: number[]) {
    await this.catalog(catalogoId);
    const where: Prisma.FantasyCatalogoAtletaWhereInput = { catalogoId,
      ...(clubs ? { clubeIdExterno: { in: clubs } } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.fantasyCatalogoAtleta.findMany({ where, orderBy: { id: 'asc' }, skip: (page.page - 1) * page.limit, take: page.limit }),
      this.prisma.fantasyCatalogoAtleta.count({ where }),
    ]);
    return { items, total, page: page.page, limit: page.limit };
  }

  async references(id: number, type: 'clubes' | 'posicoes') {
    const catalog = await this.catalog(id);
    const refs = catalog.referencias as unknown as CatalogReferences;
    const athletes = await this.prisma.fantasyCatalogoAtleta.findMany({ where: { catalogoId: id },
      distinct: type === 'clubes' ? ['clubeIdExterno'] : ['posicaoId'], select: { clubeIdExterno: true, posicaoId: true } });
    const ids = [...new Set(athletes.map(a => type === 'clubes' ? a.clubeIdExterno : a.posicaoId))].sort((a, b) => a - b);
    return { items: ids.map(key => ({ id: key, dados: refs[type][String(key)] })) };
  }

  async freeze(id: number) {
    return this.atomic(async tx => {
      const catalog = await this.catalog(id, tx);
      if (catalog.status === 'CONGELADO') return catalog;
      return tx.fantasyCatalogo.update({ where: { id }, data: { status: 'CONGELADO', congeladoEm: new Date() } });
    });
  }

  async createCompetition(dto: CreateFantasyCompetitionDto) {
    const start = new Date(dto.inicioInscricao);
    const end = new Date(dto.fimInscricao);
    const amount = new Prisma.Decimal(dto.valorInscricao);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end
      || (dto.tipoAcesso === 'FREE' ? !amount.isZero() : !amount.greaterThan(0))) {
      throw new BadRequestException('Periodo ou valor de inscricao invalido');
    }
    return this.atomic(async tx => {
      const catalog = await this.catalog(dto.catalogoId, tx);
      const references = catalog.referencias as unknown as CatalogReferences;
      const matches = dto.partidaIds.map(id => references.partidas.find(m => m.partidaIdExterno === id));
      if (!matches.length || matches.some(m => !m) || new Set(dto.partidaIds).size !== dto.partidaIds.length) {
        throw new BadRequestException('Selecione partidas unicas da rodada do catalogo');
      }
      if (matches.some(m => new Date(m!.inicioPrevisto) <= end) || end <= new Date()) {
        throw new BadRequestException('Inscricoes devem terminar antes de todas as partidas e no futuro');
      }
      await tx.fantasyCatalogo.update({ where: { id: catalog.id }, data: {
        status: 'CONGELADO', congeladoEm: catalog.congeladoEm ?? new Date(),
      } });
      return tx.fantasyCompeticao.create({ data: {
        catalogoId: catalog.id, temporada: catalog.temporada, rodada: catalog.rodada,
        nome: dto.nome.trim(), tipoAcesso: dto.tipoAcesso, valorInscricao: amount,
        inicioInscricao: start, fimInscricao: end, limiteEscalacoesUsuario: dto.limiteEscalacoesUsuario,
        partidas: { create: matches.map(m => ({ ...m!, inicioPrevisto: new Date(m!.inicioPrevisto) })) },
      }, include: { partidas: { orderBy: { id: 'asc' } } } });
    });
  }

  async competitions(page: FantasyPageDto) {
    const where = { status: 'PUBLICADA' };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.fantasyCompeticao.findMany({ where, skip: (page.page - 1) * page.limit, take: page.limit, orderBy: { id: 'desc' } }),
      this.prisma.fantasyCompeticao.count({ where }),
    ]);
    return { items, total, page: page.page, limit: page.limit };
  }

  async competition(id: number, db: Prisma.TransactionClient = this.prisma, admin = false) {
    const competition = await db.fantasyCompeticao.findFirst({ where: { id, ...(admin ? {} : { status: 'PUBLICADA' }) },
      include: { partidas: { orderBy: { id: 'asc' } } } });
    if (!competition) throw new NotFoundException('Competicao Fantasy nao encontrada');
    return competition;
  }

  async ranking(id: number, page: LineupPageDto, usuarioId?: number) {
    // One read snapshot for visibility, entries and total, without write locks.
    return this.prisma.$transaction(async tx => {
      const competition = await this.competition(id, tx);
      const where = { competicaoId: id, status: 'INSCRITA' };
      const [items, total] = await Promise.all([
        tx.fantasyEscalacao.findMany({ where, orderBy: { id: 'asc' },
          skip: (page.page - 1) * page.limit, take: page.limit,
          select: { id: true, usuarioId: true, nomePublico: true, sequencial: true, formacao: true,
            identidade: { select: { identificadorPublico: true, nomeBase: true } } } }),
        tx.fantasyEscalacao.count({ where }),
      ]);
      const now = new Date();
      const notStarted = competition.partidas.length > 0 && competition.partidas.every(match =>
        match.status === 'AGENDADA' && match.inicioReal === null
        && Number.isFinite(match.inicioPrevisto.getTime()) && match.inicioPrevisto > now);
      return { competicaoId: id, estadoPontuacao: notStarted ? 'NAO_INICIADA' : 'INDISPONIVEL',
        items: items.map(item => ({ posicao: null, escalacaoId: item.id, nomePublico: item.nomePublico,
          identidade: item.identidade ? { ...item.identidade, sequencial: item.sequencial } : null,
          formacao: item.formacao, pontuacao: null, meuTime: usuarioId !== undefined && item.usuarioId === usuarioId })),
        total, page: page.page, limit: page.limit };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async eligible(id: number, page: FantasyPageDto) {
    const competition = await this.competition(id);
    const clubs = [...new Set(competition.partidas.flatMap(m => [m.clubeMandanteId, m.clubeVisitanteId]))];
    return this.athletes(competition.catalogoId, page, clubs);
  }

  async publish(id: number) {
    return this.atomic(async tx => {
      const competition = await this.competition(id, tx, true);
      if (competition.status === 'PUBLICADA') return competition;
      const catalog = await this.catalog(competition.catalogoId, tx);
      if (catalog.status !== 'CONGELADO' || !competition.partidas.length || competition.fimInscricao <= new Date()
        || competition.partidas.some(m => m.inicioPrevisto <= competition.fimInscricao)) {
        throw new ConflictException('Competicao sem catalogo congelado, partidas ou janela valida');
      }
      return tx.fantasyCompeticao.update({ where: { id }, data: { status: 'PUBLICADA' }, include: { partidas: true } });
    });
  }
}
