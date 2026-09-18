import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CompeticaoLigaStatus, PremiacaoCompeticaoTipo, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminPremiacaoInputDto, AdminPremiacaoResponseDto } from './dto/admin-premiacoes.dto';

const premiacaoSelect = {
  id: true, competicaoLigaId: true, posicaoInicio: true, posicaoFim: true,
  tipoPremiacao: true, valor: true, percentual: true, ordem: true,
  criadoEm: true, atualizadoEm: true,
} satisfies Prisma.PremiacaoCompeticaoSelect;

type PremiacaoRow = Prisma.PremiacaoCompeticaoGetPayload<{ select: typeof premiacaoSelect }>;

const premiacaoOrderBy = [
  { posicaoInicio: 'asc' as const }, { ordem: 'asc' as const }, { id: 'asc' as const },
];

function mapear(row: PremiacaoRow): AdminPremiacaoResponseDto {
  return {
    ...row,
    valor: row.valor?.toNumber() ?? null,
    percentual: row.percentual?.toNumber() ?? null,
    criadoEm: row.criadoEm.toISOString(),
    atualizadoEm: row.atualizadoEm.toISOString(),
  };
}

@Injectable()
export class AdminPremiacoesService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(competicaoId: number): Promise<AdminPremiacaoResponseDto[]> {
    const competicao = await this.prisma.competicaoLiga.findUnique({ where: { id: competicaoId }, select: { id: true } });
    if (!competicao) throw new NotFoundException('Competicao nao encontrada.');
    const rows = await this.prisma.premiacaoCompeticao.findMany({
      where: { competicaoLigaId: competicaoId }, select: premiacaoSelect, orderBy: premiacaoOrderBy,
    });
    return rows.map(mapear);
  }

  substituir(competicaoId: number, premiacoes: AdminPremiacaoInputDto[]): Promise<AdminPremiacaoResponseDto[]> {
    return this.prisma.$transaction(async tx => {
      // O mesmo lock de COMPETICAO_LIGA usado nas inscricoes serializa substituicoes concorrentes.
      const lock = await tx.$queryRaw<Array<{ ID: number }>>`
        SELECT ID FROM COMPETICAO_LIGA WHERE ID = ${competicaoId} FOR UPDATE`;
      if (!lock.length) throw new NotFoundException('Competicao nao encontrada.');

      const competicao = await tx.competicaoLiga.findUnique({
        where: { id: competicaoId }, select: { status: true, limiteParticipantes: true },
      });
      if (!competicao) throw new NotFoundException('Competicao nao encontrada.');
      if (competicao.status !== CompeticaoLigaStatus.RASCUNHO
        && competicao.status !== CompeticaoLigaStatus.INSCRICOES_ABERTAS) {
        throw new ConflictException('Premiacao congelada para o estado atual da competicao.');
      }

      const dados = this.validarEPreparar(competicaoId, premiacoes, competicao.limiteParticipantes);
      await tx.premiacaoCompeticao.deleteMany({ where: { competicaoLigaId: competicaoId } });
      if (dados.length) await tx.premiacaoCompeticao.createMany({ data: dados });
      const rows = await tx.premiacaoCompeticao.findMany({
        where: { competicaoLigaId: competicaoId }, select: premiacaoSelect, orderBy: premiacaoOrderBy,
      });
      return rows.map(mapear);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private validarEPreparar(competicaoId: number, premiacoes: AdminPremiacaoInputDto[], limite: number | null): Prisma.PremiacaoCompeticaoCreateManyInput[] {
    const ordenadas = premiacoes.map((premiacao, indice) => ({ ...premiacao, indice }))
      .sort((a, b) => a.posicaoInicio - b.posicaoInicio || a.posicaoFim - b.posicaoFim || a.indice - b.indice);
    let fimAnterior = 0;
    let percentualTotal = new Prisma.Decimal(0);
    for (const premiacao of ordenadas) {
      if (!Number.isSafeInteger(premiacao.posicaoInicio) || premiacao.posicaoInicio <= 0
        || !Number.isSafeInteger(premiacao.posicaoFim) || premiacao.posicaoFim < premiacao.posicaoInicio) {
        throw new BadRequestException('Faixa de posicoes invalida.');
      }
      if (premiacao.posicaoInicio <= fimAnterior) throw new BadRequestException('Faixas de premiacao nao podem se sobrepor.');
      if (limite !== null && premiacao.posicaoFim > limite) {
        throw new BadRequestException('Faixa de premiacao ultrapassa o limite de participantes.');
      }
      fimAnterior = premiacao.posicaoFim;

      const temValor = premiacao.valor !== null && premiacao.valor !== undefined;
      const temPercentual = premiacao.percentual !== null && premiacao.percentual !== undefined;
      if (premiacao.tipoPremiacao === PremiacaoCompeticaoTipo.VALOR_FIXO) {
        if (!temValor || temPercentual || !Number.isFinite(premiacao.valor) || premiacao.valor! < 0) {
          throw new BadRequestException('VALOR_FIXO exige valor nao negativo e percentual nulo.');
        }
      } else if (premiacao.tipoPremiacao === PremiacaoCompeticaoTipo.PERCENTUAL) {
        if (!temPercentual || temValor || !Number.isFinite(premiacao.percentual)
          || premiacao.percentual! <= 0 || premiacao.percentual! > 100) {
          throw new BadRequestException('PERCENTUAL exige percentual maior que zero e menor ou igual a 100, com valor nulo.');
        }
        percentualTotal = percentualTotal.plus(premiacao.percentual!);
      } else {
        throw new BadRequestException('Tipo de premiacao invalido.');
      }
    }
    if (percentualTotal.gt(100)) throw new BadRequestException('Soma das premiacoes percentuais nao pode ultrapassar 100%.');

    return premiacoes.map((premiacao, indice) => ({
      competicaoLigaId: competicaoId,
      posicaoInicio: premiacao.posicaoInicio,
      posicaoFim: premiacao.posicaoFim,
      tipoPremiacao: premiacao.tipoPremiacao,
      valor: premiacao.tipoPremiacao === PremiacaoCompeticaoTipo.VALOR_FIXO ? premiacao.valor : null,
      percentual: premiacao.tipoPremiacao === PremiacaoCompeticaoTipo.PERCENTUAL ? premiacao.percentual : null,
      ordem: premiacao.ordem ?? indice,
    }));
  }
}
