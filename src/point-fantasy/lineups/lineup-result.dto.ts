export interface LineupResultSummaryDto {
  pontuacao: string | null;
  estadoPontuacao: 'PARCIAL' | 'INDISPONIVEL';
  revisao: string;
  atualizadoEm: Date;
  posicao: number | null;
}
export type ParticipationOrigin = 'REGISTRO_OFICIAL' | 'NAO_PARTICIPACAO_INFERIDA_CARTOLA' | 'INFORMACAO_AUSENTE' | 'IDENTIDADE_INCOMPATIVEL';
export interface LineupAthleteResultDto {
  catalogoAtletaId: number;
  papelOriginal: 'TITULAR' | 'TECNICO' | 'RESERVA';
  pontuacaoOficial: string | null;
  pontuacaoContabilizada: string;
  multiplicador: number;
  titularEfetivo: boolean;
  capitaoOriginal: boolean;
  capitaoEfetivo: boolean;
  reservaMagoDesignado: boolean;
  reservaUtilizado: boolean;
  utilizadoComoMago: boolean;
  entrouEmCampo: boolean | null;
  origemParticipacao: ParticipationOrigin;
}
export interface LineupSubstitutionDto {
  titularSaiuId: number;
  reservaEntrouId: number;
  regra: 'COMUM' | 'MAGO';
  pontuacaoOficial: string;
  pontuacaoContabilizada: string;
  multiplicador: number;
  herdouCapitao: boolean;
}
export interface LineupResultDetailDto extends LineupResultSummaryDto {
  capitaoOriginalAtletaId: number | null;
  capitaoEfetivoAtletaId: number | null;
  reservaMagoAtletaId: number | null;
  reservasUtilizados: number[];
  titularesSubstituidos: number[];
  contribuicoes: { titularOriginalAtletaId: number; catalogoAtletaId: number; pontuacaoContabilizada: string; multiplicador: number }[];
  atletas: LineupAthleteResultDto[];
  substituicoes: LineupSubstitutionDto[];
}
