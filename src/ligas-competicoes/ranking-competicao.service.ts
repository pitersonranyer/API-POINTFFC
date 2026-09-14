import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RankingCompeticaoResponseDto } from './dto/ranking-competicao.dto';

export interface AtualizacaoPontuacaoInscricao {
  inscricaoId: number;
  pontuacao: Prisma.Decimal | string | number;
}

@Injectable()
export class RankingCompeticaoService {
  constructor(private readonly prisma: PrismaService) {}

  async consultar(competicaoId: number): Promise<RankingCompeticaoResponseDto> {
    const competicao = await this.prisma.competicaoLiga.findFirst({
      where: { id: competicaoId, visivelApp: true,
        ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: true }, modalidade: { ativa: true } } },
      select: { id: true, nome: true },
    });
    if (!competicao) throw new NotFoundException('Competicao nao encontrada.');

    const rows = await this.prisma.inscricaoTimeCompeticao.findMany({
      where: { competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' },
      select: { id: true, timeIdCartola: true, nomeTime: true, nomeCartoleiro: true, escudoUrl: true,
        pontuacao: true, posicao: true, posicaoAnterior: true, premioApurado: true },
      orderBy: [{ posicao: { sort: 'asc', nulls: 'last' } },
        { pontuacao: { sort: 'desc', nulls: 'last' } }, { dataInscricao: 'asc' }, { id: 'asc' }],
    });
    return {
      competicaoId: competicao.id,
      nomeCompeticao: competicao.nome,
      quantidadeParticipantes: rows.length,
      ranking: rows.map(row => ({
        inscricaoId: row.id, timeIdCartola: row.timeIdCartola,
        nomeTime: row.nomeTime, nomeCartoleiro: row.nomeCartoleiro, escudoUrl: row.escudoUrl,
        pontuacao: row.pontuacao?.toNumber() ?? null, posicao: row.posicao,
        posicaoAnterior: row.posicaoAnterior, premioApurado: row.premioApurado?.toNumber() ?? null,
      })),
    };
  }

  async atualizarPontuacoes(competicaoId: number, atualizacoes: AtualizacaoPontuacaoInscricao[]): Promise<void> {
    if (!Number.isSafeInteger(competicaoId) || competicaoId < 1 || competicaoId > 4294967295 || !Array.isArray(atualizacoes)) {
      throw new BadRequestException('Competicao ou atualizacoes invalidas.');
    }
    const novasPontuacoes = new Map<number, Prisma.Decimal>();
    for (const atualizacao of atualizacoes) {
      if (!atualizacao || !Number.isSafeInteger(atualizacao.inscricaoId)
        || atualizacao.inscricaoId < 1 || atualizacao.inscricaoId > 4294967295
        || novasPontuacoes.has(atualizacao.inscricaoId)) {
        throw new BadRequestException('IDs de inscricao invalidos ou duplicados.');
      }
      let pontuacao: Prisma.Decimal;
      try { pontuacao = new Prisma.Decimal(atualizacao.pontuacao); }
      catch { throw new BadRequestException('Pontuacao invalida.'); }
      if (!pontuacao.isFinite() || pontuacao.decimalPlaces() > 2 || pontuacao.abs().gt('9999999999.99')) {
        throw new BadRequestException('Pontuacao fora do formato DECIMAL(12,2).');
      }
      novasPontuacoes.set(atualizacao.inscricaoId, pontuacao);
    }

    await this.prisma.$transaction(async tx => {
      // Mesmo bloqueio usado pela inscricao: evita novas entradas durante a reordenacao.
      const lock = await tx.$queryRaw<{ ID: number }[]>`SELECT ID FROM COMPETICAO_LIGA WHERE ID = ${competicaoId} FOR UPDATE`;
      if (!lock.length) throw new NotFoundException('Competicao nao encontrada.');

      const inscricoes = await tx.inscricaoTimeCompeticao.findMany({
        where: { competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' },
        select: { id: true, pontuacao: true, posicao: true, dataInscricao: true },
      });
      const idsAtivos = new Set(inscricoes.map(inscricao => inscricao.id));
      if ([...novasPontuacoes.keys()].some(id => !idsAtivos.has(id))) {
        throw new BadRequestException('Inscricao inexistente, inativa ou de outra competicao.');
      }

      const ordenadas = inscricoes.map(inscricao => ({
        ...inscricao, novaPontuacao: novasPontuacoes.get(inscricao.id) ?? inscricao.pontuacao,
      })).sort((a, b) => {
        if (a.novaPontuacao === null && b.novaPontuacao !== null) return 1;
        if (b.novaPontuacao === null && a.novaPontuacao !== null) return -1;
        if (a.novaPontuacao !== null && b.novaPontuacao !== null) {
          const diferenca = b.novaPontuacao.comparedTo(a.novaPontuacao);
          if (diferenca !== 0) return diferenca;
        }
        return a.dataInscricao.getTime() - b.dataInscricao.getTime() || a.id - b.id;
      });

      for (const [index, inscricao] of ordenadas.entries()) {
        const result = await tx.inscricaoTimeCompeticao.updateMany({
          where: { id: inscricao.id, competicaoLigaId: competicaoId, statusInscricao: 'ATIVA' },
          data: { pontuacao: inscricao.novaPontuacao,
            posicaoAnterior: inscricao.posicao, posicao: index + 1 },
        });
        if (result.count !== 1) throw new ConflictException('Inscricao alterada durante a atualizacao do ranking.');
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
