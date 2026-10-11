import { Prisma } from '@prisma/client';
import { AthleteHistoryIndicatorsDto } from './dto/athlete-history-response.dto';

export interface AthleteHistorySample { rodada: number; pontuacao: number }

export function athleteHistoryMetrics(samples: AthleteHistorySample[], reference: number): AthleteHistoryIndicatorsDto {
  const valid = samples.filter(s => Number.isFinite(s.pontuacao) && s.rodada >= 1 && s.rodada <= reference)
    .sort((a, b) => a.rodada - b.rodada);
  const recent = valid.filter(s => s.rodada >= Math.max(1, reference - 4));
  const mean = (values: AthleteHistorySample[]) => values.reduce((sum, s) => sum.plus(s.pontuacao), new Prisma.Decimal(0)).div(values.length);
  const rounded = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  const average = valid.length ? mean(valid) : null;
  const variance = average && valid.length >= 2
    ? valid.reduce((sum, s) => sum.plus(new Prisma.Decimal(s.pontuacao).minus(average).pow(2)), new Prisma.Decimal(0)).div(valid.length)
    : null;
  // Strict comparison keeps the earliest round when extrema tie.
  const extreme = (maximum: boolean) => valid.length ? valid.reduce((best, s) =>
    (maximum ? s.pontuacao > best.pontuacao : s.pontuacao < best.pontuacao) ? s : best) : null;
  return {
    mediaGeralDisponivel: average === null ? null : rounded(average),
    mediaUltimas5: recent.length ? rounded(mean(recent)) : null,
    maior: extreme(true), menor: extreme(false),
    desvioPadrao: variance === null ? null : rounded(variance.sqrt()),
    amostraGeral: valid.length, amostraUltimas5: recent.length,
  };
}
