import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { generatePublicTeamCode, normalizeTeamName, PUBLIC_TEAM_CODE_ATTEMPTS, PublicTeamCodeCollision } from './team-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfirmFreeLineupsDto, CreateLineupDto, LineupPageDto, UpdateLineupDto } from './lineup.dto';
import { LineupSelection, selectionIds, validateSelection } from './lineup.rules';
import { readResultDetail, readResultSummaries } from './lineup-result.read';

const include = { identidade: true, atletas: { include: { atleta: true }, orderBy: { id: 'asc' as const } } };
type StoredLineup = Prisma.FantasyEscalacaoGetPayload<{ include: typeof include }>;
type Competition = Prisma.FantasyCompeticaoGetPayload<{ include: { catalogo: true; partidas: true } }>;

export function assertLineupEditable(c: Competition, now = new Date()) {
  if (c.status !== 'PUBLICADA' || c.catalogo.status !== 'CONGELADO'
    || c.temporada !== c.catalogo.temporada || c.rodada !== c.catalogo.rodada
    || c.inicioInscricao > now || (c.fechamentoDefinitivoEm !== null && c.fechamentoDefinitivoEm <= now)
    || !c.partidas.length || c.partidas.some(m => m.status !== 'AGENDADA' || m.inicioReal !== null
      || !Number.isFinite(m.inicioPrevisto.getTime()) || m.inicioPrevisto <= now)) {
    throw new ConflictException('Escalacao bloqueada: competicao indisponivel ou primeira partida iniciada/prevista');
  }
}

@Injectable()
export class LineupService {
  constructor(private readonly prisma: PrismaService) {}

  private async atomic<T>(action: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < PUBLIC_TEAM_CODE_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (e) {
        if (e instanceof PublicTeamCodeCollision) {
          if (attempt + 1 < PUBLIC_TEAM_CODE_ATTEMPTS) continue;
          throw new ConflictException('Nao foi possivel atribuir codigo publico; repita a solicitacao com os mesmos parametros');
        }
        if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2025', 'P2034'].includes(e.code)) {
          throw new ConflictException('Escalacao alterada por outra solicitacao; recarregue a versao atual');
        }
        throw e;
      }
    }
    throw new ConflictException('Nao foi possivel atribuir codigo publico');
  }

  private async active(tx: Prisma.TransactionClient, usuarioId: number) {
    const user = await tx.usuario.findUnique({ where: { idUsuario: usuarioId }, select: { status: true } });
    if (user?.status !== 'ATIVO') throw new ForbiddenException('Usuario ativo necessario');
  }

  private async competition(tx: Prisma.TransactionClient, id: number) {
    const c = await tx.fantasyCompeticao.findUnique({ where: { id }, include: { catalogo: true, partidas: true } });
    if (!c) throw new NotFoundException('Competicao Fantasy nao encontrada');
    return c;
  }

  private async owned(tx: Prisma.TransactionClient, usuarioId: number, id: number) {
    const lineup = await tx.fantasyEscalacao.findFirst({ where: { id, usuarioId }, include });
    if (!lineup) throw new NotFoundException('Escalacao nao encontrada');
    return lineup;
  }

  private selection(lineup: StoredLineup): LineupSelection {
    return { formacao: lineup.formacao, titulares: lineup.atletas.filter(a => a.papel === 'TITULAR').map(a => a.catalogoAtletaId),
      tecnico: lineup.atletas.find(a => a.papel === 'TECNICO')?.catalogoAtletaId ?? null,
      reservas: lineup.atletas.filter(a => a.papel === 'RESERVA').map(a => a.catalogoAtletaId),
      capitaoAtletaId: lineup.capitaoAtletaId, reservaMagoAtletaId: lineup.reservaMagoAtletaId };
  }

  private response(lineup: StoredLineup) {
    const selection = this.selection(lineup);
    return { id: lineup.id, competicaoId: lineup.competicaoId, status: lineup.status, versao: lineup.versao,
      confirmadaEm: lineup.confirmadaEm ?? null,
      nomePublico: lineup.nomePublico ?? null, sequencial: lineup.sequencial ?? null,
      legado: !lineup.identidadeId, identidade: lineup.identidade ? this.identityResponse(lineup.identidade) : null,
      criadoEm: lineup.criadoEm, atualizadoEm: lineup.atualizadoEm, ...selection,
      atletas: lineup.atletas.map(a => ({ catalogoAtletaId: a.catalogoAtletaId, papel: a.papel, atleta: a.atleta })),
      validacao: validateSelection(selection, lineup.atletas.map(a => a.atleta)) };
  }

  private identityResponse(identity: Prisma.FantasyTimeIdentidadeGetPayload<object>) {
    return { nomeBase: identity.nomeBase, identificadorPublico: identity.identificadorPublico,
      ultimoSequencial: identity.ultimoSequencial };
  }

  private version(lineup: StoredLineup, versao: number, allowRegistered = false) {
    if ((lineup.status !== 'RASCUNHO' && !(allowRegistered && lineup.status === 'INSCRITA')) || lineup.versao !== versao || versao >= 4294967295) {
      throw new ConflictException('Versao desatualizada ou escalacao indisponivel');
    }
  }

  private rows(s: LineupSelection) {
    return [
      ...s.titulares.map(catalogoAtletaId => ({ catalogoAtletaId, papel: 'TITULAR' as const })),
      ...(s.tecnico === null ? [] : [{ catalogoAtletaId: s.tecnico, papel: 'TECNICO' as const }]),
      ...s.reservas.map(catalogoAtletaId => ({ catalogoAtletaId, papel: 'RESERVA' as const })),
    ];
  }

  private async validate(tx: Prisma.TransactionClient, c: Competition, s: LineupSelection) {
    const ids = selectionIds(s);
    const clubs = [...new Set(c.partidas.flatMap(m => [m.clubeMandanteId, m.clubeVisitanteId]))];
    const athletes = ids.length ? await tx.fantasyCatalogoAtleta.findMany({ where: {
      id: { in: ids }, catalogoId: c.catalogoId, clubeIdExterno: { in: clubs },
    } }) : [];
    return validateSelection(s, athletes);
  }

  private async createWithin(tx: Prisma.TransactionClient, usuarioId: number, c: Competition, s: LineupSelection,
    options: { nomeBase?: string; chaveIdempotencia?: string } = {}, origin = 'create') {
    assertLineupEditable(c);
    await this.validate(tx, c, s);
    let identity = await tx.fantasyTimeIdentidade.findUnique({ where: { usuarioId_competicaoId: { usuarioId, competicaoId: c.id } } });
    const name = options.nomeBase === undefined ? undefined : normalizeTeamName(options.nomeBase);
    const fingerprint = createHash('sha256').update(JSON.stringify({ origin, s, name: name ?? null })).digest('hex');
    if (identity && options.chaveIdempotencia) {
      const operation = await tx.fantasyTimeOperacao.findUnique({ where: { identidadeId_chave: {
        identidadeId: identity.id, chave: options.chaveIdempotencia,
      } } });
      if (operation) {
        if (operation.fingerprint !== fingerprint) throw new ConflictException('Chave de idempotencia reutilizada com parametros diferentes');
        const saved = await tx.fantasyEscalacao.findFirst({ where: { id: operation.escalacaoId, usuarioId, competicaoId: c.id }, include });
        if (!saved) throw new ConflictException('Operacao ja concluida; rascunho excluido');
        return this.response(saved);
      }
    }
    if (identity && name !== undefined && name !== identity.nomeBase) throw new ConflictException('Nome-base definitivo nao pode ser alterado');
    if (!identity) {
      try {
        identity = await tx.fantasyTimeIdentidade.create({ data: {
          usuarioId, competicaoId: c.id, nomeBase: name ?? normalizeTeamName(), identificadorPublico: generatePublicTeamCode(),
        } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const target = error.meta?.target;
          if (target === 'FANTASY_TIME_IDENTIDADE_IDENTIFICADOR_PUBLICO_key'
            || (Array.isArray(target) && target.length === 1 && ['identificadorPublico', 'IDENTIFICADOR_PUBLICO'].includes(target[0]))) {
            throw new PublicTeamCodeCollision();
          }
        }
        throw error;
      }
    }
    if (identity.ultimoSequencial >= 4294967295) throw new ConflictException('Sequencial esgotado');
    identity = await tx.fantasyTimeIdentidade.update({ where: { id: identity.id }, data: { ultimoSequencial: { increment: 1 } } });
    const sequencial = identity.ultimoSequencial;
    const nomePublico = '#' + identity.identificadorPublico + ' \u00b7 ' + identity.nomeBase + ' ' + String(sequencial).padStart(2, '0');
    const lineup = await tx.fantasyEscalacao.create({ data: {
      usuarioId, competicaoId: c.id, identidadeId: identity.id, sequencial, nomePublico, formacao: s.formacao, status: 'RASCUNHO',
      capitaoAtletaId: s.capitaoAtletaId, reservaMagoAtletaId: s.reservaMagoAtletaId,
      atletas: { create: this.rows(s) },
    }, include });
    assertLineupEditable(c);
    if (options.chaveIdempotencia) await tx.fantasyTimeOperacao.create({ data: {
      identidadeId: identity.id, chave: options.chaveIdempotencia, fingerprint, escalacaoId: lineup.id,
    } });
    return this.response(lineup);
  }

  async create(usuarioId: number, competicaoId: number, dto: CreateLineupDto) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const c = await this.competition(tx, competicaoId);
      return this.createWithin(tx, usuarioId, c, { formacao: dto.formacao, titulares: dto.titulares ?? [],
        tecnico: dto.tecnico ?? null, reservas: dto.reservas ?? [], capitaoAtletaId: dto.capitaoAtletaId ?? null,
        reservaMagoAtletaId: dto.reservaMagoAtletaId ?? null }, dto);
    });
  }

  async confirmFree(usuarioId: number, competicaoId: number, dto: ConfirmFreeLineupsDto) {
    const ids = [...dto.escalacaoIds].sort((a, b) => a - b);
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) {
      throw new BadRequestException('Selecione de 1 a 100 escalacoes unicas');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(ids)).digest('hex');
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      // Serialize confirmations for this competition, including the confirmed-count check.
      await tx.$queryRaw`SELECT ID FROM FANTASY_COMPETICAO WHERE ID = ${competicaoId} FOR UPDATE`;
      const key = { usuarioId, competicaoId, chave: dto.chaveIdempotencia };
      const previous = await tx.fantasyInscricaoOperacao.findUnique({ where: { usuarioId_competicaoId_chave: key } });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ConflictException('Chave de idempotencia reutilizada com parametros diferentes');
        return previous.resultado;
      }
      const check = async () => {
        await this.active(tx, usuarioId);
        const c = await this.competition(tx, competicaoId);
        assertLineupEditable(c);
        if (c.tipoAcesso !== 'FREE' || !c.valorInscricao.isZero()) throw new ConflictException('Somente inscricao FREE disponivel');
        if (new Date() >= c.fimInscricao) throw new ConflictException('Periodo de inscricao encerrado');
        return c;
      };
      const c = await check();
      const lineups = await tx.fantasyEscalacao.findMany({ where: { id: { in: ids }, usuarioId, competicaoId }, include, orderBy: { id: 'asc' } });
      if (lineups.length !== ids.length) throw new NotFoundException('Escalacoes nao encontradas nesta competicao');
      for (const lineup of lineups) {
        this.version(lineup, lineup.versao);
        if (!(await this.validate(tx, c, this.selection(lineup))).completa) throw new BadRequestException('Escalacao incompleta');
      }
      const count = await tx.fantasyEscalacao.count({ where: { usuarioId, competicaoId, status: 'INSCRITA' } });
      if (c.limiteEscalacoesUsuario !== null && count + ids.length > c.limiteEscalacoesUsuario) {
        throw new ConflictException('Limite de escalacoes inscritas excedido');
      }
      const confirmadaEm = new Date();
      const resultado = { competicao: { id: c.id, nome: c.nome, tipoAcesso: c.tipoAcesso },
        escalacoes: lineups.map(l => ({ id: l.id, nomePublico: l.nomePublico, status: 'INSCRITA', confirmadaEm: confirmadaEm.toISOString() })),
        quantidadeConfirmada: ids.length, valorTotal: '0.00', estado: 'CONFIRMADA' };
      const operation = await tx.fantasyInscricaoOperacao.create({ data: { ...key, fingerprint, resultado } });
      for (const lineup of lineups) {
        const changed = await tx.fantasyEscalacao.updateMany({ where: { id: lineup.id, usuarioId, competicaoId, status: 'RASCUNHO', versao: lineup.versao },
          data: { status: 'INSCRITA', confirmadaEm, inscricaoOperacaoId: operation.id, versao: { increment: 1 } } });
        if (changed.count !== 1) throw new ConflictException('Escalacao alterada durante inscricao');
      }
      // A deadline reached while persisting rolls the entire batch back.
      await check();
      return resultado;
    });
  }

  async list(usuarioId: number, competicaoId: number, page: LineupPageDto) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const competition = await this.competition(tx, competicaoId);
      const where = { usuarioId, competicaoId };
      const [items, total] = await Promise.all([
        tx.fantasyEscalacao.findMany({ where, skip: (page.page - 1) * page.limit, take: page.limit, orderBy: { id: 'desc' }, include }),
        tx.fantasyEscalacao.count({ where }),
      ]);
      const identity = await tx.fantasyTimeIdentidade.findUnique({ where: { usuarioId_competicaoId: { usuarioId, competicaoId } } });
      const legados = await tx.fantasyEscalacao.count({ where: { ...where, identidadeId: null } });
      const results = items.length ? await readResultSummaries(tx, competition) : null;
      return { identidade: identity ? this.identityResponse(identity) : null,
        estadoIdentidade: identity ? 'DEFINIDA' : legados ? 'LEGADO' : 'NOVO', rascunhosLegados: legados,
        items: items.map(item => ({ ...this.response(item),
          ...(results?.summaries.has(item.id) ? { resultado: results.summaries.get(item.id) } : {}) })), total, page: page.page, limit: page.limit };
    });
  }

  async get(usuarioId: number, id: number) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const lineup = await tx.fantasyEscalacao.findFirst({ where: { id, usuarioId }, include })
        ?? await tx.fantasyEscalacao.findFirst({ where: { id, status: 'INSCRITA', competicao: {
          status: 'PUBLICADA', fechamentoDefinitivoEm: { not: null, lte: new Date() },
        } }, include });
      if (!lineup) throw new NotFoundException('Escalacao nao encontrada');
      const competition = await this.competition(tx, lineup.competicaoId);
      const context = await readResultSummaries(tx, competition);
      const resultado = await readResultDetail(tx, competition, lineup, context);
      return { ...this.response(lineup), ...(resultado ? { resultado } : {}) };
    });
  }

  async update(usuarioId: number, id: number, dto: UpdateLineupDto) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const lineup = await this.owned(tx, usuarioId, id);
      const registered = lineup.status === 'INSCRITA';
      this.version(lineup, dto.versao, true);
      if (registered) {
        // Same competition lock as confirmation. Serializable reads protect the
        // catalog and match rows against administrative writes until commit.
        await tx.$queryRaw`SELECT ID FROM FANTASY_COMPETICAO WHERE ID = ${lineup.competicaoId} FOR UPDATE`;
      }
      const check = async () => {
        const current = await this.competition(tx, lineup.competicaoId);
        assertLineupEditable(current);
        if (registered) {
          await this.active(tx, usuarioId);
          if (current.tipoAcesso !== 'FREE' || !current.valorInscricao.isZero()) {
            throw new ConflictException('Somente edicao de inscritos FREE disponivel');
          }
          if (new Date() >= current.fimInscricao) throw new ConflictException('Periodo de edicao encerrado');
        }
        return current;
      };
      const c = await check();
      const previous = this.selection(lineup);
      const selection: LineupSelection = {
        formacao: dto.formacao ?? previous.formacao, titulares: dto.titulares ?? previous.titulares,
        reservas: dto.reservas ?? previous.reservas, tecnico: dto.tecnico === undefined ? previous.tecnico : dto.tecnico,
        capitaoAtletaId: dto.capitaoAtletaId === undefined ? previous.capitaoAtletaId : dto.capitaoAtletaId,
        reservaMagoAtletaId: dto.reservaMagoAtletaId === undefined ? previous.reservaMagoAtletaId : dto.reservaMagoAtletaId,
      };
      const validation = await this.validate(tx, c, selection);
      if (registered && !validation.completa) throw new BadRequestException('Escalacao inscrita deve permanecer completa');
      const changed = await tx.fantasyEscalacao.updateMany({ where: { id, usuarioId, versao: dto.versao, status: lineup.status },
        data: { formacao: selection.formacao, capitaoAtletaId: selection.capitaoAtletaId,
          reservaMagoAtletaId: selection.reservaMagoAtletaId, versao: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('Versao desatualizada');
      await tx.fantasyEscalacaoAtleta.deleteMany({ where: { escalacaoId: id } });
      const rows = this.rows(selection);
      if (rows.length) await tx.fantasyEscalacaoAtleta.createMany({ data: rows.map(row => ({ ...row, escalacaoId: id })) });
      const result = this.response(await this.owned(tx, usuarioId, id));
      if (registered) await check();
      else assertLineupEditable(c);
      return result;
    });
  }

  async duplicate(usuarioId: number, id: number, versao: number, options: { nomeBase?: string; chaveIdempotencia?: string } = {}) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const lineup = await this.owned(tx, usuarioId, id);
      this.version(lineup, versao);
      const c = await this.competition(tx, lineup.competicaoId);
      return this.createWithin(tx, usuarioId, c, this.selection(lineup), options, 'duplicate:' + id + ':' + versao);
    });
  }

  async remove(usuarioId: number, id: number, versao: number) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const lineup = await this.owned(tx, usuarioId, id);
      this.version(lineup, versao);
      const c = await this.competition(tx, lineup.competicaoId);
      assertLineupEditable(c);
      const result = await tx.fantasyEscalacao.deleteMany({ where: { id, usuarioId, versao, status: 'RASCUNHO' } });
      if (result.count !== 1) throw new ConflictException('Versao desatualizada');
      assertLineupEditable(c);
      return { id, excluida: true };
    });
  }
}
