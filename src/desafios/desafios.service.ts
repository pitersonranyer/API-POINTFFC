import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DesafioPartidaStatus, DesafioStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DesafioDetalheDto, DesafioPalpiteSalvoDto, DesafioResumoDto, DesafiosPaginaDto } from './dto/desafios-response.dto';
import { ListarDesafiosQueryDto, SalvarDesafioPalpiteDto } from './dto/desafios.dto';
import { mapearMinhaDesafioInscricao, minhaDesafioInscricaoSelect } from './desafio-inscricao';
import { statusDoDesafio } from './desafio-periodo';

const desafioSelect = {
  id: true, nome: true, descricao: true, tipoAcesso: true, valorInscricao: true, status: true,
  inicioInscricao: true, fimInscricao: true, dataInicio: true, dataFim: true, publicadoEm: true,
} satisfies Prisma.DesafioSelect;

const partidaSelect = {
  id: true, ordem: true, nomeCompeticao: true, nomeMandante: true, logoMandanteUrl: true,
  nomeVisitante: true, logoVisitanteUrl: true, dataInicio: true, status: true,
  resultado: true, golsMandante: true, golsVisitante: true,
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
      where: { desafioId: id, usuarioId }, select: { desafioPartidaId: true, palpite: true },
    });
    const meusPalpites = new Map(palpites.map(palpite => [palpite.desafioPartidaId, palpite.palpite]));
    const minhaInscricao = usuarioId === undefined ? null : await this.prisma.desafioInscricao.findUnique({
      where: { desafioId_usuarioId: { desafioId: id, usuarioId } }, select: minhaDesafioInscricaoSelect,
    });
    const agora = new Date();
    if (!disponivel(desafio, agora)) throw new NotFoundException('Desafio nao encontrado ou indisponivel.');
    return { ...mapear(desafio), ...(usuarioId === undefined ? {} : {
      inscrito: minhaInscricao?.status === 'ATIVA', minhaInscricao: minhaInscricao ? mapearMinhaDesafioInscricao(minhaInscricao) : null,
    }), partidas: desafio.partidas.map(partida => ({
      id: partida.id, ordem: partida.ordem, nomeCompeticao: partida.nomeCompeticao,
      nomeMandante: partida.nomeMandante, logoMandanteUrl: partida.logoMandanteUrl,
      nomeVisitante: partida.nomeVisitante, logoVisitanteUrl: partida.logoVisitanteUrl,
      dataInicio: partida.dataInicio.toISOString(), status: partida.status,
      fechamentoEm: partida.dataInicio.toISOString(),
      podeAlterarPalpite: usuarioId !== undefined && agora < desafio.dataFim && partidaAberta(partida, agora),
      ...(usuarioId === undefined ? {} : { meuPalpite: meusPalpites.get(partida.id) ?? null }),
    })) };
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
      const salvo = await tx.desafioPalpite.upsert({
        where: { desafioPartidaId_usuarioId: { desafioPartidaId: partidaId, usuarioId } },
        create: { desafioId: id, desafioPartidaId: partidaId, usuarioId, palpite: dto.palpite },
        update: { palpite: dto.palpite }, select: { palpite: true },
      });
      // Se a escrita atravessou o fechamento, desfaz a transacao em vez de aceitar um palpite tardio.
      validar();
      return { desafioId: id, partidaId, palpite: salvo.palpite,
        fechamentoEm: partida.dataInicio.toISOString(), podeAlterarPalpite: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
