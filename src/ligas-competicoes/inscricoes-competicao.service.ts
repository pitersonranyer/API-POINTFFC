import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CompeticaoLigaStatus, CompeticaoTipoAcesso, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CriarInscricoesResponseDto, MinhaInscricaoDto, ParticipanteCompeticaoDto } from './dto/inscricoes-competicao.dto';

export const minhaSelect = {
  id: true, timeIdCartola: true, nomeTime: true, nomeCartoleiro: true, escudoUrl: true,
  statusInscricao: true, pontuacao: true, posicao: true, posicaoAnterior: true,
  premioApurado: true, dataInscricao: true, valorInscricao: true,
} satisfies Prisma.InscricaoTimeCompeticaoSelect;
type MinhaRow = Prisma.InscricaoTimeCompeticaoGetPayload<{ select: typeof minhaSelect }>;

export function mapMinha(row: MinhaRow): MinhaInscricaoDto {
  return {
    ...row,
    pontuacao: row.pontuacao?.toNumber() ?? null,
    premioApurado: row.premioApurado?.toNumber() ?? null,
    valorInscricao: row.valorInscricao.toNumber(),
    dataInscricao: row.dataInscricao.toISOString(),
  };
}

export type MotivoBloqueio = 'COMPETICAO_NAO_FREE' | 'INSCRICOES_FECHADAS' | 'FORA_JANELA_INSCRICAO'
  | 'COMPETICAO_INDISPONIVEL' | 'LIMITE_PARTICIPANTES_ATINGIDO' | 'LIMITE_TIMES_USUARIO_ATINGIDO';

export interface DadosDisponibilidade {
  visivelApp: boolean;
  tipoAcesso: CompeticaoTipoAcesso;
  valorInscricao: Prisma.Decimal;
  status: CompeticaoLigaStatus;
  inicioInscricao: Date | null;
  fimInscricao: Date | null;
  limiteTimesUsuario: number | null;
  limiteParticipantes: number | null;
  ligaModalidade: { ativa: boolean; liga: { status: string; visivelApp?: boolean }; modalidade: { ativa: boolean } };
}

export function motivoBloqueioInscricao(
  competicao: DadosDisponibilidade,
  now: Date,
  contagens?: { participantes: number; timesUsuario: number },
): MotivoBloqueio | null {
  if (!competicao.visivelApp || !competicao.ligaModalidade.ativa
    || competicao.ligaModalidade.liga.status !== 'ATIVA' || competicao.ligaModalidade.liga.visivelApp === false
    || !competicao.ligaModalidade.modalidade.ativa) {
    return 'COMPETICAO_INDISPONIVEL';
  }
  if ((competicao.tipoAcesso === 'FREE' && !competicao.valorInscricao.isZero())
    || (competicao.tipoAcesso === 'PAGO' && !competicao.valorInscricao.gt(0))) return 'COMPETICAO_INDISPONIVEL';
  if (competicao.status !== 'INSCRICOES_ABERTAS') return 'INSCRICOES_FECHADAS';
  if ((competicao.inicioInscricao && now < competicao.inicioInscricao)
    || (competicao.fimInscricao && now > competicao.fimInscricao)) return 'FORA_JANELA_INSCRICAO';
  if (contagens && competicao.limiteParticipantes !== null && contagens.participantes >= competicao.limiteParticipantes) {
    return 'LIMITE_PARTICIPANTES_ATINGIDO';
  }
  if (contagens && competicao.limiteTimesUsuario !== null && contagens.timesUsuario >= competicao.limiteTimesUsuario) {
    return 'LIMITE_TIMES_USUARIO_ATINGIDO';
  }
  return null;
}

function erroInscricao(motivo: MotivoBloqueio): ConflictException {
  if (motivo === 'LIMITE_PARTICIPANTES_ATINGIDO') return new ConflictException('Limite de participantes atingido.');
  if (motivo === 'LIMITE_TIMES_USUARIO_ATINGIDO') return new ConflictException('Limite de times por usuario atingido.');
  return new ConflictException('Inscricoes indisponiveis para esta competicao.');
}

@Injectable()
export class InscricoesCompeticaoService {
  constructor(private readonly prisma: PrismaService) {}

  async criar(competicaoId: number, usuarioId: number, timesCartolaIds: number[]): Promise<CriarInscricoesResponseDto> {
    try {
      return await this.prisma.$transaction(async tx => {
        // Serializa inscricoes desta competicao antes de contar vagas, inclusive quando ainda nao ha inscritos.
        const lock = await tx.$queryRaw<{ ID: number }[]>`SELECT ID FROM COMPETICAO_LIGA WHERE ID = ${competicaoId} FOR UPDATE`;
        if (!lock.length) throw new NotFoundException('Competicao nao encontrada.');

        const competicao = await tx.competicaoLiga.findUnique({ where: { id: competicaoId }, select: {
          visivelApp: true, tipoAcesso: true, valorInscricao: true, status: true,
          inicioInscricao: true, fimInscricao: true, limiteTimesUsuario: true, limiteParticipantes: true,
          ligaModalidade: { select: { ativa: true, liga: { select: { status: true, visivelApp: true } }, modalidade: { select: { ativa: true } } } },
        } });
        if (!competicao) throw new NotFoundException('Competicao nao encontrada.');
        // Contrato legado continua exclusivo para FREE.
        if (competicao.tipoAcesso !== 'FREE' || !competicao.valorInscricao.isZero()) throw erroInscricao('COMPETICAO_NAO_FREE');
        const now = new Date();
        const bloqueio = motivoBloqueioInscricao(competicao, now);
        if (bloqueio) throw erroInscricao(bloqueio);

        const times = await tx.timeUsuario.findMany({
          where: { usuarioId, timeId: { in: timesCartolaIds } },
          select: { timeId: true, nome: true, nomeCartola: true, urlEscudoPng: true },
        });
        const timesPorId = new Map(times.map(time => [time.timeId, time]));
        const ausentes = timesCartolaIds.filter(timeId => !timesPorId.has(timeId));
        if (ausentes.length) throw new NotFoundException({
          message: 'Um ou mais times nao foram encontrados entre os times do usuario.',
          errors: ausentes.map(timeIdCartola => ({ timeIdCartola, reason: 'TIME_NAO_PERTENCE_AO_USUARIO' })),
        });

        const existentes = await tx.inscricaoTimeCompeticao.findMany({
          where: { competicaoLigaId: competicaoId, timeIdCartola: { in: timesCartolaIds } },
          select: { timeIdCartola: true },
        });
        if (existentes.length) throw new ConflictException({
          message: 'Lote de inscricoes invalido.',
          errors: existentes.map(({ timeIdCartola }) => ({ timeIdCartola, reason: 'TIME_JA_INSCRITO' })),
        });

        const timesUsuario = competicao.limiteTimesUsuario === null ? 0
          : await tx.inscricaoTimeCompeticao.count({
            where: { competicaoLigaId: competicaoId, usuarioId, statusInscricao: 'ATIVA' },
          });
        const participantes = competicao.limiteParticipantes === null ? 0
          : await tx.inscricaoTimeCompeticao.count({
            where: { competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' },
          });
        const quantidadeNovas = timesCartolaIds.length;
        if (competicao.limiteTimesUsuario !== null
          && timesUsuario + quantidadeNovas > competicao.limiteTimesUsuario) {
          throw erroInscricao('LIMITE_TIMES_USUARIO_ATINGIDO');
        }
        if (competicao.limiteParticipantes !== null
          && participantes + quantidadeNovas > competicao.limiteParticipantes) {
          throw erroInscricao('LIMITE_PARTICIPANTES_ATINGIDO');
        }

        const inscricoes: MinhaInscricaoDto[] = [];
        for (const timeIdCartola of timesCartolaIds) {
          const time = timesPorId.get(timeIdCartola)!;
          const inscricao = await tx.inscricaoTimeCompeticao.create({
            data: {
              competicaoLigaId: competicaoId, usuarioId, timeIdCartola: time.timeId,
              nomeTime: time.nome, nomeCartoleiro: time.nomeCartola, escudoUrl: time.urlEscudoPng,
              valorInscricao: competicao.valorInscricao, statusInscricao: 'ATIVA', dataInscricao: now,
            },
            select: minhaSelect,
          });
          inscricoes.push(mapMinha(inscricao));
        }
        return { inscricoes, quantidade: inscricoes.length };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Este time ja esta inscrito nesta competicao.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Inscricao concorrente; tente novamente.');
      }
      throw error;
    }
  }

  async minhas(competicaoId: number, usuarioId: number): Promise<MinhaInscricaoDto[]> {
    const competicao = await this.prisma.competicaoLiga.findUnique({ where: { id: competicaoId }, select: { id: true } });
    if (!competicao) throw new NotFoundException('Competicao nao encontrada.');
    const rows = await this.prisma.inscricaoTimeCompeticao.findMany({
      where: { competicaoLigaId: competicaoId, usuarioId },
      select: minhaSelect,
      orderBy: [{ dataInscricao: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapMinha);
  }

  async participantes(competicaoId: number): Promise<ParticipanteCompeticaoDto[]> {
    const competicao = await this.prisma.competicaoLiga.findFirst({
      where: { id: competicaoId, visivelApp: true,
        ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: true }, modalidade: { ativa: true } } },
      select: { id: true },
    });
    if (!competicao) throw new NotFoundException('Competicao nao encontrada.');
    const rows = await this.prisma.inscricaoTimeCompeticao.findMany({
      where: { competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' },
      select: { id: true, nomeTime: true, nomeCartoleiro: true, escudoUrl: true,
        pontuacao: true, posicao: true, posicaoAnterior: true },
      orderBy: [{ posicao: { sort: 'asc', nulls: 'last' } }, { dataInscricao: 'asc' }, { id: 'asc' }],
    });
    return rows.map(row => ({ ...row, pontuacao: row.pontuacao?.toNumber() ?? null }));
  }
}
