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

export interface CartolaTimePayload {
  time_id?: number;
  nome?: string;
  nome_cartola?: string;
  cartoleiro_nome?: string;
  slug?: string;
  url_escudo_png?: string;
  url_escudo_svg?: string;
  patrimonio?: number;
  [key: string]: unknown;
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
  mercadoAberto: boolean;
  bolaRolando: boolean;
}
