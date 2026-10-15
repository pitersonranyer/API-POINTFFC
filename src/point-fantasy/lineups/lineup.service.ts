import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLineupDto, LineupPageDto, UpdateLineupDto } from './lineup.dto';
import { LineupSelection, selectionIds, validateSelection } from './lineup.rules';

const include = { atletas: { include: { atleta: true }, orderBy: { id: 'asc' as const } } };
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
    try {
      return await this.prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2025', 'P2034'].includes(e.code)) {
        throw new ConflictException('Escalacao alterada por outra solicitacao; recarregue a versao atual');
      }
      throw e;
    }
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
      criadoEm: lineup.criadoEm, atualizadoEm: lineup.atualizadoEm, ...selection,
      atletas: lineup.atletas.map(a => ({ catalogoAtletaId: a.catalogoAtletaId, papel: a.papel, atleta: a.atleta })),
      validacao: validateSelection(selection, lineup.atletas.map(a => a.atleta)) };
  }

  private version(lineup: StoredLineup, versao: number) {
    if (lineup.status !== 'RASCUNHO' || lineup.versao !== versao || versao >= 4294967295) {
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

  private async createWithin(tx: Prisma.TransactionClient, usuarioId: number, c: Competition, s: LineupSelection) {
    assertLineupEditable(c);
    await this.validate(tx, c, s);
    const lineup = await tx.fantasyEscalacao.create({ data: {
      usuarioId, competicaoId: c.id, formacao: s.formacao, status: 'RASCUNHO',
      capitaoAtletaId: s.capitaoAtletaId, reservaMagoAtletaId: s.reservaMagoAtletaId,
      atletas: { create: this.rows(s) },
    }, include });
    assertLineupEditable(c);
    return this.response(lineup);
  }

  async create(usuarioId: number, competicaoId: number, dto: CreateLineupDto) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const c = await this.competition(tx, competicaoId);
      return this.createWithin(tx, usuarioId, c, { formacao: dto.formacao, titulares: dto.titulares ?? [],
        tecnico: dto.tecnico ?? null, reservas: dto.reservas ?? [], capitaoAtletaId: dto.capitaoAtletaId ?? null,
        reservaMagoAtletaId: dto.reservaMagoAtletaId ?? null });
    });
  }

  async list(usuarioId: number, competicaoId: number, page: LineupPageDto) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      await this.competition(tx, competicaoId);
      const where = { usuarioId, competicaoId };
      const [items, total] = await Promise.all([
        tx.fantasyEscalacao.findMany({ where, skip: (page.page - 1) * page.limit, take: page.limit, orderBy: { id: 'desc' }, include }),
        tx.fantasyEscalacao.count({ where }),
      ]);
      return { items: items.map(item => this.response(item)), total, page: page.page, limit: page.limit };
    });
  }

  async get(usuarioId: number, id: number) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      return this.response(await this.owned(tx, usuarioId, id));
    });
  }

  async update(usuarioId: number, id: number, dto: UpdateLineupDto) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const lineup = await this.owned(tx, usuarioId, id);
      this.version(lineup, dto.versao);
      const c = await this.competition(tx, lineup.competicaoId);
      assertLineupEditable(c);
      const previous = this.selection(lineup);
      const selection: LineupSelection = {
        formacao: dto.formacao ?? previous.formacao, titulares: dto.titulares ?? previous.titulares,
        reservas: dto.reservas ?? previous.reservas, tecnico: dto.tecnico === undefined ? previous.tecnico : dto.tecnico,
        capitaoAtletaId: dto.capitaoAtletaId === undefined ? previous.capitaoAtletaId : dto.capitaoAtletaId,
        reservaMagoAtletaId: dto.reservaMagoAtletaId === undefined ? previous.reservaMagoAtletaId : dto.reservaMagoAtletaId,
      };
      await this.validate(tx, c, selection);
      const changed = await tx.fantasyEscalacao.updateMany({ where: { id, usuarioId, versao: dto.versao, status: 'RASCUNHO' },
        data: { formacao: selection.formacao, capitaoAtletaId: selection.capitaoAtletaId,
          reservaMagoAtletaId: selection.reservaMagoAtletaId, versao: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('Versao desatualizada');
      await tx.fantasyEscalacaoAtleta.deleteMany({ where: { escalacaoId: id } });
      const rows = this.rows(selection);
      if (rows.length) await tx.fantasyEscalacaoAtleta.createMany({ data: rows.map(row => ({ ...row, escalacaoId: id })) });
      const result = this.response(await this.owned(tx, usuarioId, id));
      assertLineupEditable(c);
      return result;
    });
  }

  async duplicate(usuarioId: number, id: number, versao: number) {
    return this.atomic(async tx => {
      await this.active(tx, usuarioId);
      const lineup = await this.owned(tx, usuarioId, id);
      this.version(lineup, versao);
      const c = await this.competition(tx, lineup.competicaoId);
      return this.createWithin(tx, usuarioId, c, this.selection(lineup));
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
