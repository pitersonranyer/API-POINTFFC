import { Injectable } from '@nestjs/common';
import { PontuacaoTimeRodadaStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RankingGeralResponseDto } from './dto/ranking-geral-response.dto';

export interface ConsultarRankingGeralInput {
  temporada: number;
  rodada: number;
  limit: number;
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
    const countQuery = this.prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS total
      FROM TIME_RODADA tr
      INNER JOIN PONTUACAO_TIME_RODADA p ON p.TIME_RODADA_ID = tr.ID
      WHERE tr.TEMPORADA = ${input.temporada}
        AND tr.RODADA = ${input.rodada}
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
      ORDER BY p.PONTUACAO DESC, tr.TIME_ID ASC
      LIMIT ${input.limit}
    `;
    const [countRows, rows] = await this.prisma.$transaction([countQuery, rankingQuery]);

    return {
      temporada: input.temporada,
      rodada: input.rodada,
      total: Number(countRows[0]?.total ?? 0),
      ranking: rows.map((row, index) => ({
        posicao: index + 1,
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
