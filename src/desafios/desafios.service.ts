import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DesafioPartidaStatus, DesafioStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DesafioDetalheDto, DesafioPalpiteSalvoDto, DesafioResumoDto, DesafiosPaginaDto } from './dto/desafios-response.dto';
import { ListarDesafiosQueryDto, SalvarDesafioPalpiteDto } from './dto/desafios.dto';
import { mapearMinhaDesafioInscricao, minhaDesafioInscricaoSelect, resolverDesafioInscricao } from './desafio-inscricao';
import { CriarDesafioCartelaDto, MinhaDesafioInscricaoDto } from './dto/desafio-participacao.dto';
import { statusDoDesafio } from './desafio-periodo';
import { nomesClube } from '../futebol/futebol-clubes';

const desafioSelect = {
  id: true, nome: true, descricao: true, tipoAcesso: true, valorInscricao: true, status: true,
  inicioInscricao: true, fimInscricao: true, dataInicio: true, dataFim: true, publicadoEm: true,
  limiteInscricoesPorUsuario: true,
} satisfies Prisma.DesafioSelect;

const partidaSelect = {
  id: true, ordem: true, nomeCompeticao: true, nomeMandante: true, logoMandanteUrl: true,
  nomeVisitante: true, logoVisitanteUrl: true, dataInicio: true, status: true,
  resultado: true, golsMandante: true, golsVisitante: true,
  mandanteIdApiFootball: true, visitanteIdApiFootball: true,
} satisfies Prisma.DesafioPartidaSelect;

type DesafioRow = Prisma.DesafioGetPayload<{ select: typeof desafioSelect }>;
type PartidaRow = Prisma.DesafioPartidaGetPayload<{ select: typeof partidaSelect }>;

const estadosPublicos: DesafioStatus[] = [DesafioStatus.ABERTO, DesafioStatus.EM_ANDAMENTO];

function visiveis(agora: Date): Prisma.DesafioWhereInput {
  return { status: { in: estadosPublicos }, publicadoEm: { lte: agora },
    inicioInscricao: { lte: agora } };
}

function disponivel(desafio: DesafioRow, agora: Date): boolean {
  return estadosPublicos.includes(desafio.status) && desafio.publicadoEm !== null && desafio.publicadoEm <= agora
    && desafio.inicioInscricao <= agora;
}

function partidaAberta(partida: PartidaRow, agora: Date): boolean {
  return partida.status === DesafioPartidaStatus.AGENDADA && agora < partida.dataInicio
    && partida.resultado === null && partida.golsMandante === null && partida.golsVisitante === null;
}

function mapear(desafio: DesafioRow): DesafioResumoDto {
  return {
    id: desafio.id, nome: desafio.nome, descricao: desafio.descricao, tipoAcesso: desafio.tipoAcesso,
    limiteInscricoesPorUsuario: desafio.limiteInscricoesPorUsuario,
    valorInscricao: desafio.valorInscricao.toFixed(2), status: statusDoDesafio(desafio),
    inicioInscricao: desafio.inicioInscricao.toISOString(), fimInscricao: desafio.fimInscricao.toISOString(),
    dataInicio: desafio.dataInicio.toISOString(), dataFim: desafio.dataFim.toISOString(),
  };
}

@Injectable()
export class DesafiosService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(query: ListarDesafiosQueryDto): Promise<DesafiosPaginaDto> {
    const where: Prisma.DesafioWhereInput = { ...visiveis(new Date()),
      ...(query.tipoAcesso !== undefined ? { tipoAcesso: query.tipoAcesso } : {}) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.desafio.count({ where }),
      this.prisma.desafio.findMany({ where, select: desafioSelect, orderBy: [{ dataInicio: 'asc' }, { id: 'asc' }],
        skip: (query.pagina - 1) * query.limite, take: query.limite }),
    ]);
    return { itens: rows.map(mapear), paginacao: {
      pagina: query.pagina, limite: query.limite, total, totalPaginas: Math.ceil(total / query.limite),
    } };
  }

  async buscar(id: number, usuarioId?: number): Promise<DesafioDetalheDto> {
    const desafio = await this.prisma.desafio.findFirst({
      where: { id, ...visiveis(new Date()) },
      select: { ...desafioSelect, partidas: { select: partidaSelect, orderBy: [{ ordem: 'asc' }, { id: 'asc' }] } },
    });
    if (!desafio) throw new NotFoundException('Desafio nao encontrado ou indisponivel.');
    const palpites = usuarioId === undefined ? [] : await this.prisma.desafioPalpite.findMany({
      where: { desafioId: id, usuarioId }, select: { inscricaoId: true, desafioPartidaId: true, palpite: true, pontos: true, apurado: true },
    });
    const inscricoes = usuarioId === undefined ? [] : await this.prisma.desafioInscricao.findMany({
      where: { desafioId: id, usuarioId }, select: minhaDesafioInscricaoSelect, orderBy: { sequencia: 'asc' },
    });
    const primeira = inscricoes.find(i => i.sequencia === 1);
    const minhaInscricao = primeira?.status === 'RASCUNHO' ? null : primeira;
    const meusPalpites = new Map(palpites.filter(p => p.inscricaoId === primeira?.id).map(p => [p.desafioPartidaId, p]));
    const porCartela = new Map(palpites.map(p => [`${p.inscricaoId}:${p.desafioPartidaId}`, p]));
    const agora = new Date();
    if (!disponivel(desafio, agora)) throw new NotFoundException('Desafio nao encontrado ou indisponivel.');
    return { ...mapear(desafio), ...(usuarioId === undefined ? {} : {
      inscrito: inscricoes.some(i => i.status === 'ATIVA'), minhaInscricao: minhaInscricao ? mapearMinhaDesafioInscricao(minhaInscricao) : null,
      quantidadeUtilizada: inscricoes.filter(i => i.status === 'ATIVA').length,
      minhasInscricoes: inscricoes.map(i => ({ ...mapearMinhaDesafioInscricao(i), palpites: desafio.partidas.map(p => {
        const palpite = porCartela.get(`${i.id}:${p.id}`);
        return { partidaId: p.id, meuPalpite: palpite?.palpite ?? null, pontos: palpite?.pontos?.toNumber() ?? null,
          apurado: palpite?.apurado ?? false,
          podeAlterarPalpite: i.status !== 'CANCELADA' && agora < desafio.dataFim && partidaAberta(p, agora) };
      }) })),
    }), partidas: desafio.partidas.map(partida => ({
      id: partida.id, ordem: partida.ordem, nomeCompeticao: partida.nomeCompeticao,
      nomeMandante: nomesClube(partida.mandanteIdApiFootball, partida.nomeMandante, null).nome, logoMandanteUrl: partida.logoMandanteUrl,
      nomeVisitante: nomesClube(partida.visitanteIdApiFootball, partida.nomeVisitante, null).nome, logoVisitanteUrl: partida.logoVisitanteUrl,
      dataInicio: partida.dataInicio.toISOString(), status: partida.status,
      statusInterno: partida.status, golsMandante: partida.golsMandante, golsVisitante: partida.golsVisitante,
      fechamentoEm: partida.dataInicio.toISOString(),
      podeAlterarPalpite: usuarioId !== undefined && primeira?.status !== 'CANCELADA'
        && agora < desafio.dataFim && partidaAberta(partida, agora),
      ...(usuarioId === undefined ? {} : {
        meuPalpite: meusPalpites.get(partida.id)?.palpite ?? null,
        pontos: meusPalpites.get(partida.id)?.pontos?.toNumber() ?? null,
        apurado: meusPalpites.get(partida.id)?.apurado ?? false,
      }),
    })) };
  }

  criarCartela(id: number, usuarioId: number, dto: CriarDesafioCartelaDto): Promise<MinhaDesafioInscricaoDto> {
    return this.prisma.$transaction(async tx => {
      const locks = await tx.$queryRaw<Array<{ ID: number | bigint }>>`SELECT ID FROM DESAFIO WHERE ID = ${id} FOR UPDATE`;
      if (!locks.length) throw new NotFoundException('Desafio nao encontrado.');
      const existente = await tx.desafioInscricao.findUnique({ where: {
        desafioId_usuarioId_chaveIdempotencia: { desafioId: id, usuarioId, chaveIdempotencia: dto.chaveIdempotencia },
      }, select: minhaDesafioInscricaoSelect });
      if (existente) return mapearMinhaDesafioInscricao(existente);
      const desafio = await tx.desafio.findUnique({ where: { id }, select: desafioSelect });
      const agora = new Date();
      if (!desafio || !disponivel(desafio, agora) || agora >= desafio.dataFim) {
        throw new ConflictException('Desafio indisponivel para nova cartela.');
      }
      const ultima = await tx.desafioInscricao.findFirst({ where: { desafioId: id, usuarioId },
        select: { sequencia: true }, orderBy: { sequencia: 'desc' } });
      const sequencia = (ultima?.sequencia ?? 0) + 1;
      if (sequencia > 4294967295) throw new ConflictException('Limite de cartelas atingido.');
      const row = await tx.desafioInscricao.create({ data: { desafioId: id, usuarioId, sequencia,
        chaveIdempotencia: dto.chaveIdempotencia, status: 'RASCUNHO', valorInscricao: new Prisma.Decimal(0) },
      select: minhaDesafioInscricaoSelect });
      return mapearMinhaDesafioInscricao(row);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  salvarPalpite(id: number, partidaId: number, usuarioId: number, dto: SalvarDesafioPalpiteDto): Promise<DesafioPalpiteSalvoDto> {
    return this.prisma.$transaction(async tx => {
      // Mesmo lock e ordem das etapas administrativas: cancelamento/composicao nao podem mudar durante a gravacao.
      const desafios = await tx.$queryRaw<Array<{ ID: number | bigint }>>`
        SELECT ID FROM DESAFIO WHERE ID = ${id} FOR UPDATE`;
      if (!desafios.length) throw new NotFoundException('Desafio nao encontrado.');
      const partidas = await tx.$queryRaw<Array<{ ID: number | bigint }>>`
        SELECT ID FROM DESAFIO_PARTIDA WHERE ID = ${partidaId} AND DESAFIO_ID = ${id} FOR UPDATE`;
      if (!partidas.length) throw new NotFoundException('Partida nao encontrada neste Desafio.');
      const desafio = await tx.desafio.findUnique({ where: { id }, select: desafioSelect });
      const partida = await tx.desafioPartida.findFirst({ where: { id: partidaId, desafioId: id }, select: partidaSelect });
      if (!desafio || !partida) throw new NotFoundException('Desafio ou partida nao encontrado.');

      const validar = () => {
        // Hora do backend lida depois dos locks; fimInscricao e dataInicio global nao fecham palpites.
        const agora = new Date();
        if (!disponivel(desafio, agora) || agora >= desafio.dataFim) throw new ConflictException('Desafio indisponivel para palpites.');
        if (!partidaAberta(partida, agora)) throw new ConflictException('Partida fechada ou nao elegivel para palpites.');
      };
      validar();
      const inscricao = await resolverDesafioInscricao(tx, id, usuarioId, dto.inscricaoId);
      if (inscricao.status === 'CANCELADA') throw new ConflictException('Cartela cancelada nao aceita palpites.');
      const salvo = await tx.desafioPalpite.upsert({
        where: { inscricaoId_desafioPartidaId: { inscricaoId: inscricao.id, desafioPartidaId: partidaId } },
        create: { desafioId: id, desafioPartidaId: partidaId, usuarioId, inscricaoId: inscricao.id, palpite: dto.palpite },
        update: { palpite: dto.palpite }, select: { palpite: true },
      });
      // Se a escrita atravessou o fechamento, desfaz a transacao em vez de aceitar um palpite tardio.
      validar();
      return { desafioId: id, partidaId, palpite: salvo.palpite,
        fechamentoEm: partida.dataInicio.toISOString(), podeAlterarPalpite: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
