import { BadGatewayException, GatewayTimeoutException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiEvent, ApiFixture, ApiTeamStatistics } from './fantasy.types';
import { marcarDiagnostico } from './formacao-diagnostico';

@Injectable()
export class ApiFootballClient {
  private readonly logger = new Logger(ApiFootballClient.name);
  constructor(private readonly config: ConfigService) {}

  async fixture(id: number): Promise<ApiFixture> {
    const rows = await this.request<ApiFixture>(`/fixtures?id=${id}`);
    if (!rows.length) throw new NotFoundException('Partida não encontrada');
    const row = rows[0];
    if (rows.length !== 1 || row?.fixture?.id !== id || !row.fixture.status || !row.fixture.venue
      || !row.league || !row.teams?.home || !row.teams?.away || !row.goals
      || typeof row.fixture.date !== 'string' || !Number.isFinite(Date.parse(row.fixture.date))
      || typeof row.fixture.status.short !== 'string'
      || (row.fixture.venue.name !== null && typeof row.fixture.venue.name !== 'string')
      || typeof row.league.name !== 'string'
      || (row.league.round !== null && typeof row.league.round !== 'string')
      || [row.teams.home, row.teams.away].some(team => !Number.isSafeInteger(team.id) || team.id <= 0
        || typeof team.name !== 'string' || (team.logo !== null && typeof team.logo !== 'string'))
      || [row.goals.home, row.goals.away].some(goal => goal !== null && (!Number.isInteger(goal) || goal < 0))) {
      throw marcarDiagnostico(new BadGatewayException('Resposta inválida do serviço de partidas'), 'FIXTURE_INVALIDO');
    }
    return row;
  }

  async events(id: number): Promise<ApiEvent[]> {
    const rows = await this.request<ApiEvent>(`/fixtures/events?fixture=${id}`);
    if (rows.some(row => !row || !row.time || !row.team || !row.player || !row.assist
      || typeof row.type !== 'string' || typeof row.detail !== 'string'
      || (row.time.elapsed !== null && !Number.isInteger(row.time.elapsed))
      || (row.time.extra !== null && !Number.isInteger(row.time.extra)))) {
      throw new BadGatewayException('Resposta inválida do serviço de partidas');
    }
    return rows;
  }

  async statistics(id: number): Promise<ApiTeamStatistics[]> {
    const rows = await this.request<ApiTeamStatistics>(`/fixtures/statistics?fixture=${id}`);
    if (rows.some(row => !row?.team || !Number.isSafeInteger(row.team.id) || row.team.id <= 0
      || typeof row.team.name !== 'string' || (row.team.logo !== null && typeof row.team.logo !== 'string')
      || !Array.isArray(row.statistics) || row.statistics.some(stat => !stat || typeof stat.type !== 'string'
        || !Object.prototype.hasOwnProperty.call(stat, 'value')
        || (stat.value !== null && typeof stat.value !== 'number' && typeof stat.value !== 'string')))) {
      throw new BadGatewayException('Resposta inválida do serviço de partidas');
    }
    return rows;
  }

  lineups(id: number): Promise<unknown[]> {
    // Os campos parciais e dados essenciais de lineups são validados no mapper.
    return this.request<unknown>(`/fixtures/lineups?fixture=${id}`);
  }

  private async request<T>(path: string): Promise<T[]> {
    const key = this.config.get<string>('API_FOOTBALL_KEY')?.trim();
    if (!key) throw new ServiceUnavailableException('Serviço de partidas não configurado');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://v3.football.api-sports.io' + path, {
        method: 'GET', headers: { 'x-apisports-key': key, Accept: 'application/json' },
        signal: controller.signal, redirect: 'error',
      });
      if (response.status === 429) throw new ServiceUnavailableException('Limite do serviço de partidas atingido');
      if (!response.ok) throw new BadGatewayException('Falha ao consultar o serviço de partidas');
      let body: { errors?: unknown; response?: unknown } | null;
      try { body = await response.json(); }
      catch {
        if (controller.signal.aborted) throw new GatewayTimeoutException('Tempo limite do serviço de partidas excedido');
        throw marcarDiagnostico(new BadGatewayException('Resposta inválida do serviço de partidas'), 'JSON_INVALIDO');
      }
      if (!body || typeof body !== 'object' || !body.errors || typeof body.errors !== 'object'
        || Object.keys(body.errors).length || !Array.isArray(body.response)) {
        const categoria = body && typeof body === 'object' && body.errors && typeof body.errors === 'object'
          && Object.keys(body.errors).length ? 'PROVIDER_ERRORS' : 'ENVELOPE_INVALIDO';
        if (categoria === 'PROVIDER_ERRORS') this.registrarChavesProvider(body!.errors as object);
        throw marcarDiagnostico(new BadGatewayException('Resposta inválida do serviço de partidas'), categoria);
      }
      return body.response as T[];
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (controller.signal.aborted) throw new GatewayTimeoutException('Tempo limite do serviço de partidas excedido');
      throw new BadGatewayException('Não foi possível conectar ao serviço de partidas');
    } finally { clearTimeout(timer); }
  }

  private registrarChavesProvider(errors: object): void {
    // Temporário: só rótulos controlados. Nunca interpolar chaves arbitrárias ou valores externos.
    const permitidas = ['requests', 'rateLimit', 'token', 'subscription', 'season', 'request',
      'authentication', 'authorization', 'access', 'plan', 'parameters', 'fixture'];
    const chaves = Array.isArray(errors) ? ['FORMATO_ARRAY']
      : [...new Set(Object.keys(errors).map(chave => permitidas.includes(chave) ? chave : 'OUTRO'))].sort().slice(0, 8);
    this.logger.warn(`[FANTASY_API_FOOTBALL] provider_error_keys=${JSON.stringify(chaves)}`);
  }
}
