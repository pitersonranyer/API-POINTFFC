export interface CartolaMarketStatus {
  rodada_atual: number;
  status_mercado: number;
  fechamento?: Record<string, unknown>;
  bola_rolando: boolean;
  game_over?: boolean;
  temporada?: number;
  nome_rodada?: string;
  rodada_final?: number;
  [key: string]: unknown;
}

export interface CartolaMatch {
  partida_id: number;
  clube_casa_id: number;
  clube_visitante_id: number;
  partida_data?: string;
  timestamp?: number;
  local?: string;
  placar_oficial_mandante?: number | null;
  placar_oficial_visitante?: number | null;
  periodo_tr?: string;
  status_cronometro_tr?: string;
  inicio_cronometro_tr?: string;
  valida?: boolean;
  [key: string]: unknown;
}

export interface CartolaMatchesResponse {
  rodada: number;
  clubes: Record<string, unknown>;
  partidas: CartolaMatch[];
  [key: string]: unknown;
}

export type CartolaPayload = Record<string, unknown> | unknown[];

export type CartolaScouts = Record<string, number>;

export interface CartolaScoredAthlete {
  pontuacao?: number;
  scout?: CartolaScouts | null;
  entrou_em_campo?: boolean;
  clube_id?: number;
  posicao_id?: number;
  [key: string]: unknown;
}

export interface CartolaScoredAthletesPayload {
  atletas?: Record<string, CartolaScoredAthlete>;
  clubes?: Record<string, unknown>;
  posicoes?: Record<string, unknown>;
  rodada?: number;
  total_atletas?: number;
  [key: string]: unknown;
}

export interface CartolaScoredAthletesFreshResult {
  value: CartolaScoredAthletesPayload;
  ttlMs: number;
}

export interface CartolaTimePayload {
  time_id?: number;
  nome?: string;
  nome_cartola?: string;
  cartoleiro_nome?: string;
  slug?: string;
  url_escudo_png?: string;
  url_escudo_svg?: string;
  foto_perfil?: string;
  assinante?: boolean;
  patrimonio?: number;
  time?: CartolaTimeIdentity;
  [key: string]: unknown;
}

export interface CartolaTimeIdentity {
  time_id?: number;
  nome?: string;
  nome_cartola?: string;
  cartoleiro_nome?: string;
  slug?: string;
  url_escudo_png?: string;
  url_escudo_svg?: string;
  foto_perfil?: string;
  assinante?: boolean;
  [key: string]: unknown;
}

export interface CartolaSnapshotAthlete {
  atleta_id?: number;
  posicao_id?: number;
  clube_id?: number;
  [key: string]: unknown;
}

export interface CartolaSubstitutionAthlete {
  atleta_id?: number;
  apelido?: string;
  posicao_id?: number;
  [key: string]: unknown;
}

export interface CartolaTeamSubstitution {
  entrou?: CartolaSubstitutionAthlete;
  saiu?: CartolaSubstitutionAthlete;
  posicao_id?: number;
  [key: string]: unknown;
}

export type CartolaTeamSubstitutionsPayload = CartolaTeamSubstitution[];

export interface CartolaTimeSnapshotPayload extends CartolaTimePayload {
  time?: CartolaTimeIdentity;
  atletas?: CartolaSnapshotAthlete[];
  reservas?: CartolaSnapshotAthlete[];
  capitao_id?: number;
  reserva_luxo_id?: number;
  esquema_id?: number;
  patrimonio?: number;
}

export interface CartolaTeamRequestOptions {
  forceRefresh?: boolean;
  round?: number;
}

export interface CartolaTimeResumo extends CartolaTimePayload {
  timeId: number;
  nome: string;
  cartoleiro?: string;
  escudo?: string;
}

export interface CartolaBatchError {
  timeId: number;
  tipo: 'timeout' | 'api_indisponivel';
}

export interface CartolaBatchResponse {
  solicitados: number;
  encontrados: number;
  naoEncontrados: number;
  times: CartolaTimeResumo[];
  idsNaoEncontrados: number[];
  erros: CartolaBatchError[];
}

export interface CartolaDashboard {
  mercado: CartolaMarketStatus;
  rodada: number;
  mercadoAberto: boolean;
  bolaRolando: boolean;
  partidas: CartolaMatch[];
  clubes: Record<string, unknown>;
}

export interface CachedResult<T> {
  value: T;
  cache: 'hit' | 'miss' | 'stale';
  stale: boolean;
}

export interface MarketState {
  rodada: number;
  temporada?: number;
  mercadoAberto: boolean;
  bolaRolando: boolean;
}
