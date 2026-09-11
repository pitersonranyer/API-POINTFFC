import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FutebolJogosQueryDto } from './dto/futebol-query.dto';
import { FutebolCompeticaoResponseDto, FutebolJogosResponseDto, FutebolJogoResponseDto } from './dto/futebol-response.dto';

const teamSelect = { id: true, externalId: true, nome: true, nomeCurto: true, sigla: true, escudoUrl: true } as const;
const gameSelect = {
  id: true, externalId: true, temporada: true, rodada: true, fase: true, grupo: true,
  dataHoraUtc: true, status: true, vencedor: true, placarMandante: true, placarVisitante: true,
  placarIntervaloMandante: true, placarIntervaloVisitante: true,
  timeMandante: { select: teamSelect }, timeVisitante: { select: teamSelect },
} satisfies Prisma.FutebolPartidaSelect;
type GameRow = Prisma.FutebolPartidaGetPayload<{ select: typeof gameSelect }>;
function mapGame(row: GameRow): FutebolJogoResponseDto {
  return { id: row.id, externalId: row.externalId, temporada: row.temporada, rodada: row.rodada,
    fase: row.fase, grupo: row.grupo, dataHoraUtc: row.dataHoraUtc.toISOString(), status: row.status, vencedor: row.vencedor,
    mandante: row.timeMandante, visitante: row.timeVisitante,
    placar: { mandante: row.placarMandante, visitante: row.placarVisitante },
    placarIntervalo: { mandante: row.placarIntervaloMandante, visitante: row.placarIntervaloVisitante } };
}

@Injectable()
export class FutebolQueryService {
  constructor(private readonly prisma: PrismaService) {}

  listarCompeticoes(): Promise<FutebolCompeticaoResponseDto[]> {
    return this.prisma.futebolCompeticao.findMany({ where: { ativa: true }, orderBy: { codigo: 'asc' },
      select: { codigo: true, nome: true, pais: true, emblemaUrl: true, temporadaAtual: true } });
  }

  async listarJogos(codigo: string, query: FutebolJogosQueryDto): Promise<FutebolJogosResponseDto> {
    const dataHoraUtc: Prisma.DateTimeFilter = {};
    if (query.dataInicio) dataHoraUtc.gte = new Date(query.dataInicio);
    if (query.dataFim) dataHoraUtc.lte = new Date(query.dataFim.length === 10 ? query.dataFim + 'T23:59:59.999Z' : query.dataFim);
    if (dataHoraUtc.gte && dataHoraUtc.lte && dataHoraUtc.gte > dataHoraUtc.lte) throw new BadRequestException('dataInicio deve ser menor ou igual a dataFim.');
    const competition = await this.competicao(codigo);
    const temporada = query.temporada ?? competition.temporadaAtual;
    const jogos = await this.jogos({ competicaoId: competition.id, temporada, rodada: query.rodada, status: query.status, dataHoraUtc });
    return { competicao: { codigo: competition.codigo, nome: competition.nome }, temporada, total: jogos.length, jogos };
  }

  async consultarRodada(codigo: string, rodada: number): Promise<FutebolJogosResponseDto> {
    return { ...await this.listarJogos(codigo, { rodada }), rodada };
  }

  async consultarRodadaAtual(codigo: string): Promise<FutebolJogosResponseDto> {
    const competition = await this.competicao(codigo);
    const temporada = competition.temporadaAtual;
    const where = { competicaoId: competition.id, temporada, rodada: { not: null } };
    const now = new Date(Date.now());
    // Jogos em andamento têm prioridade; empates seguem data, rodada e ID.
    const live = await this.prisma.futebolPartida.findFirst({
      where: { ...where, status: { in: ['IN_PLAY', 'PAUSED'] } },
      orderBy: [{ dataHoraUtc: 'asc' }, { rodada: 'asc' }, { id: 'asc' }], select: { rodada: true },
    });
    // Agendamentos passados sem atualização de status não prendem o calendário.
    const upcoming = live ?? await this.prisma.futebolPartida.findFirst({
      where: { ...where, status: { in: ['SCHEDULED', 'TIMED'] }, dataHoraUtc: { gte: now } },
      orderBy: [{ dataHoraUtc: 'asc' }, { rodada: 'asc' }, { id: 'asc' }], select: { rodada: true },
    });
    const selected = upcoming ?? await this.prisma.futebolPartida.findFirst({
      where: { ...where, status: { in: ['FINISHED', 'AWARDED'] } },
      orderBy: [{ rodada: 'desc' }, { id: 'asc' }], select: { rodada: true },
    });
    const rodada = selected?.rodada ?? null;
    const jogos = rodada === null ? [] : await this.jogos({ competicaoId: competition.id, temporada, rodada });
    return { competicao: { codigo: competition.codigo, nome: competition.nome }, temporada, rodada, total: jogos.length, jogos };
  }

  private async competicao(codigo: string) {
    const competition = await this.prisma.futebolCompeticao.findUnique({ where: { codigo }, select: { id: true, codigo: true, nome: true, temporadaAtual: true } });
    if (!competition) throw new NotFoundException('Competição não encontrada.');
    return competition;
  }

  private async jogos(where: Prisma.FutebolPartidaWhereInput) {
    const rows = await this.prisma.futebolPartida.findMany({
      where, select: gameSelect, orderBy: [{ dataHoraUtc: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapGame);
  }
}
