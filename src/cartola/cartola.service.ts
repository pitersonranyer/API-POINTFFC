import { BadRequestException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CartolaCacheService } from './cartola-cache.service';
import { CartolaHttpClient } from './cartola-http.client';
import { CachedResult, CartolaBatchError, CartolaBatchResponse, CartolaDashboard, CartolaMarketStatus, CartolaMatchesResponse, CartolaPayload, CartolaScoredAthletesFreshResult, CartolaScoredAthletesPayload, CartolaTeamRequestOptions, CartolaTeamSubstitutionsPayload, CartolaTimePayload, CartolaTimeResumo, CartolaTimeSnapshotPayload, MarketState } from './cartola.types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const TEAM_BATCH_CONCURRENCY = 5;

@Injectable()
export class CartolaService {
  private marketRequest?: Promise<CartolaMarketStatus>;
  constructor(private readonly http: CartolaHttpClient, private readonly cache: CartolaCacheService,
    @Optional() private readonly prisma?: PrismaService) {}

  private async historicalRound(round: number, temporada?: number) {
    if (!this.prisma) return null;
    const season = temporada ?? (await this.prisma.rodadaProcessamento.findFirst({
      orderBy: { temporada: 'desc' }, select: { temporada: true },
    }))?.temporada;
    if (season === undefined) return null;
    return this.prisma.rodadaProcessamento.findUnique({ where: { temporada_rodada: { temporada: season, rodada: round } } });
  }

  loadMarketStatusFresh(): Promise<CartolaMarketStatus> {
    if (!this.marketRequest) {
      this.marketRequest = this.http.get<CartolaMarketStatus>('/mercado/status').finally(() => { this.marketRequest = undefined; });
    }
    return this.marketRequest;
  }

  loadMatchesFresh(round: number): Promise<CartolaMatchesResponse> {
    return this.http.get<CartolaMatchesResponse>(`/partidas/${round}`);
  }

  async loadFinalScoredAthletesFresh(temporada: number, round: number): Promise<CartolaScoredAthletesPayload> {
    const market = await this.loadMarketStatusFresh();
    if (market.status_mercado !== 1 || market.temporada !== temporada
      || (round !== market.rodada_atual - 1 && !(market.game_over && round === market.rodada_atual))) {
      throw new BadRequestException('Fonte final fora da janela oficial da rodada');
    }
    return this.http.get<CartolaScoredAthletesPayload>(`/atletas/pontuados/${round}`);
  }

  getMarketStatus(): Promise<CachedResult<CartolaMarketStatus>> {
    return this.cache.getOrLoad('mercado/status', (status) => this.statusTtl(status), () => this.http.get<CartolaMarketStatus>('/mercado/status'));
  }

  async getMarketAthletes(): Promise<CachedResult<CartolaPayload>> {
    const state = await this.getState();
    return this.cache.getOrLoad('atletas/mercado', state.mercadoAberto ? 3 * MINUTE : HOUR, () => this.http.get<CartolaPayload>('/atletas/mercado'));
  }

  async getScoredAthletes(round?: number, temporada?: number): Promise<CachedResult<CartolaScoredAthletesPayload>> {
    if (round !== undefined) {
      const historical = await this.historicalRound(round, temporada);
      if (historical?.status === 'CONSOLIDADA') {
        if (!historical.pontuados) throw new ServiceUnavailableException('Rodada consolidada sem atletas persistidos');
        return { value: historical.pontuados as CartolaScoredAthletesPayload, cache: 'hit', stale: false };
      }
      if (historical?.pontuados) return { value: historical.pontuados as CartolaScoredAthletesPayload, cache: 'hit', stale: false };
    }
    const state = await this.getState();
    // A ultima rodada encerrada ainda esta disponivel na fonte oficial,
    // mesmo quando o scheduler nao chegou a persistir seu historico.
    if (this.prisma && state.mercadoAberto && round === state.rodada - 1
      && (temporada === undefined || temporada === state.temporada)) {
      return this.cache.getOrLoad(
        `atletas/pontuados/${state.temporada}/${round}`, 10 * MINUTE,
        async () => {
          const value = await this.http.get<CartolaScoredAthletesPayload>(`/atletas/pontuados/${round}`);
          if (value.rodada !== round || !value.atletas || Array.isArray(value.atletas)
            || typeof value.atletas !== 'object' || Object.keys(value.atletas).length === 0) {
            throw new ServiceUnavailableException('Pontuacoes oficiais indisponiveis para a rodada solicitada');
          }
          return value;
        },
      );
    }
    if (this.prisma && round !== undefined && (state.mercadoAberto || round !== state.rodada)) {
      throw new NotFoundException('Rodada historica ainda nao consolidada no banco');
    }
    this.validateScoredAthletesRound(state, round);
    if (this.prisma) {
      if (temporada !== undefined && temporada !== state.temporada) throw new NotFoundException('Temporada sem historico persistido');
      const current = await this.historicalRound(round ?? state.rodada, state.temporada);
      if (!current?.pontuados) throw new ServiceUnavailableException('Rodada aguardando snapshot e processamento das parciais');
      return { value: current.pontuados as CartolaScoredAthletesPayload, cache: 'hit', stale: false };
    }
    const ttl = this.scoredAthletesTtl(state);
    const suffix = round === undefined ? '' : `/${round}`;
    return this.cache.getOrLoad(`atletas/pontuados${suffix}`, ttl, () => this.http.get<CartolaScoredAthletesPayload>(`/atletas/pontuados${suffix}`));
  }

  async loadScoredAthletesFresh(round?: number): Promise<CartolaScoredAthletesFreshResult> {
    if (round !== undefined) {
      const historical = await this.historicalRound(round);
      if (historical?.status === 'CONSOLIDADA') {
        if (!historical.pontuados) throw new ServiceUnavailableException('Rodada consolidada sem atletas persistidos');
        return { value: historical.pontuados as CartolaScoredAthletesPayload, ttlMs: 10 * MINUTE };
      }
    }
    const state = await this.getState();
    this.validateScoredAthletesRound(state, round);
    const suffix = round === undefined ? '' : `/${round}`;
    const value = await this.http.get<CartolaScoredAthletesPayload>(`/atletas/pontuados${suffix}`);
    return { value, ttlMs: this.scoredAthletesTtl(state) };
  }

  getClubs(): Promise<CachedResult<Record<string, unknown>>> {
    return this.cache.getOrLoad('clubes', 18 * HOUR, () => this.http.get<Record<string, unknown>>('/clubes'));
  }

  getTeamById(timeId: number, options?: CartolaTeamRequestOptions): Promise<CachedResult<CartolaTimeSnapshotPayload>> {
    const suffix = options?.round === undefined ? '' : `/${options.round}`;
    if (options?.forceRefresh) {
      return this.http.get<CartolaTimeSnapshotPayload>(`/time/id/${timeId}${suffix}`, { notFoundMessage: 'Time do Cartola não encontrado' })
        .then((value) => ({ value, cache: 'miss', stale: false }));
    }
    return this.cache.getOrLoad(`times/id/${timeId}${suffix}`, 10 * MINUTE, () => this.http.get<CartolaTimeSnapshotPayload>(`/time/id/${timeId}${suffix}`, { notFoundMessage: 'Time do Cartola não encontrado' }));
  }

  getTeamSubstitutions(timeId: number): Promise<CartolaTeamSubstitutionsPayload> {
    return this.http.get<CartolaTeamSubstitutionsPayload>(`/time/substituicoes/${timeId}`, {
      notFoundMessage: 'Substituições do time não encontradas',
    });
  }

  searchTeams(nome: string): Promise<CachedResult<CartolaTimePayload[]>> {
    const normalized = nome.trim();
    return this.cache.getOrLoad(`times/nome/${normalized.toLocaleLowerCase('pt-BR')}`, 2 * MINUTE, () => this.http.get<CartolaTimePayload[]>(`/times?q=${encodeURIComponent(normalized)}`));
  }

  async getTeamsByIds(timeIds: number[]): Promise<CachedResult<CartolaBatchResponse>> {
    const timesById = new Map<number, CartolaTimeResumo>();
    const notFound = new Set<number>();
    const errorsById = new Map<number, CartolaBatchError>();
    const cacheStates: CachedResult<unknown>['cache'][] = [];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < timeIds.length) {
        const timeId = timeIds[nextIndex++];
        try {
          const result = await this.getTeamById(timeId);
          cacheStates.push(result.cache);
          timesById.set(timeId, this.toTeamSummary(timeId, result.value));
        } catch (error) {
          if (error instanceof NotFoundException) notFound.add(timeId);
          else errorsById.set(timeId, { timeId, tipo: error instanceof ServiceUnavailableException ? 'timeout' : 'api_indisponivel' });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(TEAM_BATCH_CONCURRENCY, timeIds.length) }, () => worker()));
    const times = timeIds.flatMap((timeId) => timesById.has(timeId) ? [timesById.get(timeId)!] : []);
    const idsNaoEncontrados = timeIds.filter((timeId) => notFound.has(timeId));
    const erros = timeIds.flatMap((timeId) => errorsById.has(timeId) ? [errorsById.get(timeId)!] : []);
    return {
      value: { solicitados: timeIds.length, encontrados: times.length, naoEncontrados: idsNaoEncontrados.length, times, idsNaoEncontrados, erros },
      cache: cacheStates.length ? this.combineCache(...cacheStates) : 'miss',
      stale: cacheStates.includes('stale'),
    };
  }

  async getMatches(): Promise<CachedResult<CartolaMatchesResponse>> {
    return this.getCurrentMatches(await this.getState());
  }

  async getMatchesByRound(round: number, temporada?: number): Promise<CachedResult<CartolaMatchesResponse>> {
    const historical = await this.historicalRound(round, temporada);
    if (historical?.status === 'CONSOLIDADA') {
      if (!historical.partidas) throw new ServiceUnavailableException('Rodada consolidada sem partidas persistidas');
      return { value: historical.partidas as unknown as CartolaMatchesResponse, cache: 'hit', stale: false };
    }
    const state = await this.getState();
    if (this.prisma && ((temporada !== undefined && temporada !== state.temporada) || round < state.rodada)) {
      throw new NotFoundException('Partidas historicas ainda nao consolidadas no banco');
    }
    const ttl = round === state.rodada ? this.matchesTtl(state) : 24 * HOUR;
    return this.cache.getOrLoad(`partidas/${round}`, ttl, () => this.http.get<CartolaMatchesResponse>(`/partidas/${round}`));
  }

  async getDashboard(): Promise<CachedResult<CartolaDashboard>> {
    const market = await this.getMarketStatus();
    const state = this.toState(market.value);
    const [matches, clubs] = await Promise.all([this.getCurrentMatches(state), this.getClubs()]);
    return {
      value: {
        mercado: market.value,
        rodada: state.rodada,
        mercadoAberto: state.mercadoAberto,
        bolaRolando: state.bolaRolando,
        partidas: matches.value.partidas,
        clubes: clubs.value,
      },
      cache: this.combineCache(market.cache, matches.cache, clubs.cache),
      stale: market.stale || matches.stale || clubs.stale,
    };
  }

  private async getState(): Promise<MarketState> { return this.toState((await this.getMarketStatus()).value); }

  private toState(status: CartolaMarketStatus): MarketState {
    return { rodada: status.rodada_atual, temporada: status.temporada, mercadoAberto: status.status_mercado === 1, bolaRolando: status.bola_rolando === true };
  }

  private getCurrentMatches(state: MarketState): Promise<CachedResult<CartolaMatchesResponse>> {
    return this.cache.getOrLoad('partidas', this.matchesTtl(state), () => this.http.get<CartolaMatchesResponse>('/partidas'));
  }

  private statusTtl(status: CartolaMarketStatus): number {
    if (status.bola_rolando) return 20 * SECOND;
    return status.status_mercado === 1 ? 45 * SECOND : 30 * SECOND;
  }

  private matchesTtl(state: MarketState): number {
    if (state.bolaRolando) return 25 * SECOND;
    return state.mercadoAberto ? 3 * MINUTE : 90 * SECOND;
  }

  private scoredAthletesTtl(state: MarketState): number {
    return state.bolaRolando ? 15 * SECOND : state.mercadoAberto ? 10 * MINUTE : MINUTE;
  }

  private validateScoredAthletesRound(state: MarketState, round?: number): void {
    if (state.mercadoAberto && round === undefined) {
      throw new BadRequestException('Informe a rodada para consultar atletas pontuados com o mercado aberto');
    }
  }

  private toTeamSummary(timeId: number, team: CartolaTimePayload): CartolaTimeResumo {
    const nested = team.time;
    const source = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as CartolaTimePayload : team;
    const normalizedId = typeof source.time_id === 'number' ? source.time_id : timeId;
    const nome = typeof source.nome === 'string' ? source.nome : '';
    const cartoleiro = typeof source.nome_cartola === 'string' ? source.nome_cartola : typeof source.cartoleiro_nome === 'string' ? source.cartoleiro_nome : undefined;
    const escudo = typeof source.url_escudo_png === 'string' ? source.url_escudo_png : typeof source.url_escudo_svg === 'string' ? source.url_escudo_svg : undefined;
    return { ...source, timeId: normalizedId, nome, ...(cartoleiro ? { cartoleiro } : {}), ...(escudo ? { escudo } : {}) };
  }

  private combineCache(...states: CachedResult<unknown>['cache'][]): CachedResult<unknown>['cache'] {
    if (states.includes('stale')) return 'stale';
    if (states.every((state) => state === 'hit')) return 'hit';
    return 'miss';
  }
}
