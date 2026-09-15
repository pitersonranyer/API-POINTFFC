import { Injectable } from '@nestjs/common';
import { PontuacaoTimeRodadaStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RankingGeralResponseDto } from './dto/ranking-geral-response.dto';

export interface ConsultarRankingGeralInput {
  temporada: number;
  rodada: number;
  limit: number;
  page?: number;
  nomeTime?: string;
  nomeCartoleiro?: string;
}

interface CountRow {
  total: bigint | number;
}

interface RankingRow {
  timeId: bigint | number;
  nomeTime: string;
  nomeCartoleiro: string | null;
  escudoUrl: string | null;
  pontuacao: Prisma.Decimal | number | string;
  status: PontuacaoTimeRodadaStatus;
}

@Injectable()
export class RankingGeralService {
  constructor(private readonly prisma: PrismaService) {}

  async consultar(input: ConsultarRankingGeralInput): Promise<RankingGeralResponseDto> {
    const page = input.page ?? 1;
    const offset = (page - 1) * input.limit;
    const teamPattern = input.nomeTime?.trim() ? `%${input.nomeTime.trim().replace(/[\\%_]/g, '\\$&')}%` : null;
    const managerPattern = input.nomeCartoleiro?.trim() ? `%${input.nomeCartoleiro.trim().replace(/[\\%_]/g, '\\$&')}%` : null;
    const countQuery = this.prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS total
      FROM TIME_RODADA tr
      INNER JOIN PONTUACAO_TIME_RODADA p ON p.TIME_RODADA_ID = tr.ID
      INNER JOIN TIME_CARTOLA tc ON tc.TIME_ID = tr.TIME_ID
      WHERE tr.TEMPORADA = ${input.temporada}
        AND tr.RODADA = ${input.rodada}
        AND (${teamPattern} IS NULL OR tc.NOME_TIME LIKE ${teamPattern})
        AND (${managerPattern} IS NULL OR tc.NOME_CARTOLEIRO LIKE ${managerPattern})
    `;
    const rankingQuery = this.prisma.$queryRaw<RankingRow[]>`
      SELECT
        tr.TIME_ID AS timeId,
        tc.NOME_TIME AS nomeTime,
        tc.NOME_CARTOLEIRO AS nomeCartoleiro,
        tc.ESCUDO_URL AS escudoUrl,
        p.PONTUACAO AS pontuacao,
        p.STATUS AS status
      FROM TIME_RODADA tr
      INNER JOIN PONTUACAO_TIME_RODADA p ON p.TIME_RODADA_ID = tr.ID
      INNER JOIN TIME_CARTOLA tc ON tc.TIME_ID = tr.TIME_ID
      WHERE tr.TEMPORADA = ${input.temporada}
        AND tr.RODADA = ${input.rodada}
        AND (${teamPattern} IS NULL OR tc.NOME_TIME LIKE ${teamPattern})
        AND (${managerPattern} IS NULL OR tc.NOME_CARTOLEIRO LIKE ${managerPattern})
      ORDER BY p.PONTUACAO DESC, tr.TIME_ID ASC
      LIMIT ${input.limit}
      OFFSET ${offset}
    `;
    const [countRows, rows] = await this.prisma.$transaction([countQuery, rankingQuery]);

    const total = Number(countRows[0]?.total ?? 0);
    return {
      temporada: input.temporada,
      rodada: input.rodada,
      total,
      paginacao: { pagina: page, limite: input.limit, total, totalPaginas: Math.ceil(total / input.limit) },
      ranking: rows.map((row, index) => ({
        posicao: offset + index + 1,
        timeId: Number(row.timeId),
        nomeTime: row.nomeTime,
        nomeCartoleiro: row.nomeCartoleiro,
        escudoUrl: row.escudoUrl,
        pontuacao: new Prisma.Decimal(row.pontuacao).toNumber(),
        status: row.status,
      })),
    };
  }
}
