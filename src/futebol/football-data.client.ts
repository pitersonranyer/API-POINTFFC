import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DesafioFixture, FootballDataError, FootballDataErrorCode, mapDesafioMatch, parseDesafioMatches } from './football-data.normalizer';
import { FutebolCodigo, isFutebolCodigo } from './futebol-competicoes';
import { DesafioResultadoOficial, mapDesafioResultado, parseDesafioResultados } from './football-data-desafio-resultado';

export interface FootballDataPesquisa {
  date?: string;
  from?: string;
  to?: string;
  league?: number;
  team?: number;
  season?: number;
}

@Injectable()
export class FootballDataClient {
  private readonly logger = new Logger(FootballDataClient.name);
  constructor(private readonly config: ConfigService) {}
  private nextRequestAt = 0;
  private queue = Promise.resolve();
  getCompetition(code: FutebolCodigo = 'BSA'): Promise<unknown> { return this.get(code, ''); }
  getTeams(code: FutebolCodigo, season: number): Promise<unknown> { return this.get(code, '/teams', season); }
  getMatches(code: FutebolCodigo, season: number): Promise<unknown> { return this.get(code, '/matches', season); }

  async pesquisarPartidas(query: FootballDataPesquisa): Promise<DesafioFixture[]> {
    const from = query.date ?? query.from;
    const to = query.date ?? query.to;
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
      || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) {
      throw new FootballDataError('football-data: consulta inválida.', 'INVALID_QUERY');
    }
    // O contrato administrativo usa fim inclusivo; v4 usa dateTo exclusivo.
    const fimExclusivo = new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10);
    const params = new URLSearchParams({ dateFrom: from, dateTo: fimExclusivo });
    let path = '/matches';
    if (query.team !== undefined) {
      this.validarId(query.team);
      path = `/teams/${query.team}/matches`;
      params.set('limit', '500');
      if (query.league !== undefined) { this.validarId(query.league); params.set('competitions', String(query.league)); }
    } else if (query.league !== undefined) {
      this.validarId(query.league);
      path = `/competitions/${query.league}/matches`;
    }
    if (query.season !== undefined) {
      if ((!query.team && !query.league) || !Number.isInteger(query.season) || query.season < 1900 || query.season > 9999) {
        throw new FootballDataError('football-data: temporada exige competição ou time.', 'INVALID_QUERY');
      }
      params.set('season', String(query.season));
    }
    const matches = parseDesafioMatches(await this.request(path, params));
    if (query.team && matches.length >= 500) throw new FootballDataError('football-data: limite da lista atingido; reduza o período.', 'INVALID_QUERY');
    // Aplica os limites publicos tambem localmente, sem buscar temporadas inteiras ou outro fornecedor.
    return matches.filter(match => match.dataHoraInicio >= `${from}T00:00:00.000Z` && match.dataHoraInicio < `${fimExclusivo}T00:00:00.000Z`
      && (query.league === undefined || match.leagueId === query.league)
      && (query.team === undefined || match.mandanteId === query.team || match.visitanteId === query.team));
  }

  async buscarPartidasPorIds(ids: number[]): Promise<DesafioFixture[]> {
    return this.buscarPorIds(ids, mapDesafioMatch, parseDesafioMatches);
  }

  buscarResultadosPorIds(ids: number[]): Promise<DesafioResultadoOficial[]> {
    return this.buscarPorIds(ids, mapDesafioResultado, parseDesafioResultados);
  }

  private async buscarPorIds<T extends DesafioFixture>(ids: number[], mapear: (input: unknown) => T, listar: (input: unknown) => T[]): Promise<T[]> {
    const unicos = [...new Set(ids)];
    unicos.forEach(id => this.validarId(id));
    const matches: T[] = [];
    // Lotes de 50 limitam o tamanho da URL; /matches?ids=... suporta competicoes mistas.
    for (let i = 0; i < unicos.length; i += 50) {
      const lote = unicos.slice(i, i + 50);
      let rows: T[];
      if (lote.length === 1) {
        try { rows = [mapear(await this.request(`/matches/${lote[0]}`))]; }
        catch (error) {
          if (error instanceof FootballDataError && error.code === 'NOT_FOUND') rows = [];
          else throw error;
        }
      } else {
        rows = listar(await this.request('/matches', new URLSearchParams({ ids: lote.join(',') })));
      }
      if (rows.some(row => !lote.includes(row.fixtureId))) throw new FootballDataError('football-data: partida divergente.');
      matches.push(...rows);
    }
    return matches;
  }

  private validarId(id: number): void {
    if (!Number.isInteger(id) || id < 1 || id > 4294967295) throw new FootballDataError('football-data: identificador inválido.', 'INVALID_QUERY');
  }

  private async get(code: FutebolCodigo, path: string, season?: number): Promise<unknown> {
    if (!isFutebolCodigo(code) || (season !== undefined && (!Number.isInteger(season) || season < 1900 || season > 9999))) throw new FootballDataError('football-data: consulta inválida.', 'INVALID_QUERY');
    return this.request('/competitions/' + code + path, season === undefined ? undefined : new URLSearchParams({ season: String(season) }));
  }

  private async request(path: string, params?: URLSearchParams): Promise<unknown> {
    const token = this.config.get<string>('FOOTBALL_DATA_API_TOKEN')?.trim();
    if (!token) throw new FootballDataError('FOOTBALL_DATA_API_TOKEN não configurado.', 'NOT_CONFIGURED');
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + 6500;
    release();
    const controller = new AbortController();
    const startedAt = Date.now();
    let httpStatus: number | undefined;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://api.football-data.org/v4' + path + (params ? '?' + params.toString() : ''), {
        headers: { 'X-Auth-Token': token }, signal: controller.signal, redirect: 'error',
      });
      httpStatus = response.status;
      if (!response.ok) {
        const messages: Record<number, string> = { 401: 'token inválido (401)', 403: 'acesso negado (403)', 404: 'recurso não encontrado (404)', 429: 'limite de requisições atingido (429); tente novamente mais tarde' };
        const codes: Record<number, FootballDataErrorCode> = { 401: 'ACCESS_DENIED', 403: 'ACCESS_DENIED', 404: 'NOT_FOUND', 429: 'RATE_LIMIT' };
        throw new FootballDataError('football-data: ' + (messages[response.status] ?? (response.status >= 500 ? 'provedor indisponível (5xx)' : 'falha HTTP')) + '.',
          codes[response.status] ?? (response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_RESPONSE'));
      }
      try { return await response.json(); } catch {
        if (controller.signal.aborted) throw new FootballDataError('football-data: timeout.', 'TIMEOUT');
        throw new FootballDataError('football-data: resposta inválida.');
      }
    } catch (error) {
      if (error instanceof FootballDataError) throw error;
      throw new FootballDataError(controller.signal.aborted ? 'football-data: timeout.' : 'football-data: falha de conexão.', controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
      this.logger.log(JSON.stringify({ event: 'futebol.provider.request', path, season: params?.get('season') ?? undefined,
        startedAt: new Date(startedAt).toISOString(), at: new Date().toISOString(), durationMs: Date.now() - startedAt,
        httpStatus, timedOut: controller.signal.aborted }));
    }
  }
}
