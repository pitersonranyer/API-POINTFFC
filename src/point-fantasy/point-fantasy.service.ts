import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../cartola/cartola.service';
import { CartolaMarketStatus } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';
import { CaptureCatalogDto, CloseFantasyCompetitionDto, CreateFantasyCompetitionDto, FantasyPageDto } from './point-fantasy.dto';
import { loadCartolaEvidence } from './scoring/cartola-evidence';
import { CatalogReferences, classifyAthlete, SnapshotMatch } from './point-fantasy.rules';
import { LineupPageDto } from './lineups/lineup.dto';
import { rankScores } from './scoring/scoring-engine';
import { isCurrentResult } from './scoring/result-readiness';

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
      if (competition.fechamentoDefinitivoEm && competition.fechamentoDefinitivoEm <= new Date()) {
        const round = await tx.fantasyApuracaoRodada.findUnique({ where: {
          temporada_rodada: { temporada: competition.temporada, rodada: competition.rodada },
        } });
        const entries = await tx.fantasyEscalacao.findMany({ where: { competicaoId: id, status: 'INSCRITA' },
          include: { resultado: true, identidade: { select: { identificadorPublico: true, nomeBase: true } } },
          orderBy: { id: 'asc' } });
        const rows = rankScores(entries.map(entry => {
          const result = entry.resultado;
          const current = isCurrentResult(result, round, competition, entry.versao);
          return { escalacaoId: entry.id, total: current ? result!.total?.toFixed() ?? null : null, entry };
        }));
        const complete = rows.length > 0 && rows.every(row => row.total !== null);
        return { competicaoId: id, estadoPontuacao: complete ? 'PARCIAL' : 'INDISPONIVEL',
          items: rows.slice((page.page - 1) * page.limit, page.page * page.limit).map(({ entry, total, posicao }) => ({
            posicao: complete ? posicao : null, escalacaoId: entry.id, nomePublico: entry.nomePublico,
            identidade: entry.identidade ? { ...entry.identidade, sequencial: entry.sequencial } : null,
            formacao: entry.formacao, pontuacao: complete ? total : null,
            meuTime: usuarioId !== undefined && entry.usuarioId === usuarioId,
          })), total: entries.length, page: page.page, limit: page.limit };
      }
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
          formacao: usuarioId !== undefined && item.usuarioId === usuarioId ? item.formacao : null,
          pontuacao: null, meuTime: usuarioId !== undefined && item.usuarioId === usuarioId })),
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

  async closeCompetition(id: number, usuarioId: number, dto: CloseFantasyCompetitionDto) {
    return this.atomic(async tx => {
      const admin = await tx.usuario.findUnique({ where: { idUsuario: usuarioId }, select: { tipoUsuario: true, status: true } });
      if (admin?.tipoUsuario !== 'PLATFORM_ADMIN' || admin.status !== 'ATIVO') throw new ForbiddenException('Administrador ativo obrigatorio');
      await tx.$queryRaw`SELECT ID FROM FANTASY_COMPETICAO WHERE ID=${id} FOR UPDATE`;
      const c = await tx.fantasyCompeticao.findUniqueOrThrow({ where: { id }, include: { catalogo: true, partidas: true, fechamentoAuditoria: true } });
      if (c.temporada !== dto.temporada || c.rodada !== dto.rodada) throw new ConflictException('Identidade da competicao divergente');
      const audit = c.fechamentoAuditoria?.dados as Prisma.JsonObject | undefined;
      if (c.fechamentoDefinitivoEm) {
        if (audit?.operacaoId !== dto.operacaoId || audit.revisao !== dto.revisao || audit.hashFonte !== dto.hashFonte
          || audit.motivo !== dto.motivo || audit.usuarioId !== usuarioId) throw new ConflictException('Competicao ja fechada por outra operacao');
        return { competicaoId: id, fechamentoDefinitivoEm: c.fechamentoDefinitivoEm, auditoria: audit };
      }
      const now = new Date();
      if (c.status !== 'PUBLICADA' || c.catalogo.status !== 'CONGELADO' || c.catalogo.temporada !== c.temporada
        || c.catalogo.rodada !== c.rodada || c.fimInscricao > now || !c.partidas.length) throw new ConflictException('Competicao indisponivel para fechamento');
      await tx.$queryRaw`SELECT ID FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=${c.temporada} AND RODADA=${c.rodada} FOR UPDATE`;
      const round = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { temporada_rodada: { temporada: c.temporada, rodada: c.rodada } } });
      if (round.revisaoAtual.toString() !== dto.revisao || round.hashConteudoAtual !== dto.hashFonte) throw new ConflictException('Revisao ou hash alterados');
      const points = await tx.fantasyPontuacaoAtleta.findMany({ where: { temporada: c.temporada, rodada: c.rodada, apuracaoId: round.id } });
      const evidence = (await loadCartolaEvidence(tx, round, points, c.partidas)).assessment;
      if (!evidence.eligible) throw new ConflictException({ message: 'Evidencias Cartola insuficientes para os confrontos selecionados', impedimentos: evidence.reasons });
      const data = { operacaoId: dto.operacaoId, usuarioId, motivo: dto.motivo, temporada: c.temporada, rodada: c.rodada,
        revisao: dto.revisao, hashFonte: dto.hashFonte, fechadoEm: now.toISOString(), evidencia: evidence,
        partidas: c.partidas.map(m => ({ partidaIdExterno: m.partidaIdExterno, clubeMandanteId: m.clubeMandanteId, clubeVisitanteId: m.clubeVisitanteId })) };
      await tx.fantasyFechamentoAuditoria.create({ data: { competicaoId: id, dados: data as unknown as Prisma.InputJsonValue } });
      const updated = await tx.fantasyCompeticao.updateMany({ where: { id, fechamentoDefinitivoEm: null, atualizadoEm: c.atualizadoEm },
        data: { fechamentoDefinitivoEm: now } });
      if (updated.count !== 1) throw new ConflictException('Competicao alterada durante fechamento');
      return { competicaoId: id, fechamentoDefinitivoEm: now, auditoria: data };
    });
  }
}
