import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FootballDataError } from './football-data.normalizer';

@Injectable()
export class FootballDataClient {
  constructor(private readonly config: ConfigService) {}
  getCompetition(code: 'BSA' = 'BSA'): Promise<unknown> { return this.get(code, ''); }
  getTeams(code: 'BSA', season: number): Promise<unknown> { return this.get(code, '/teams', season); }
  getMatches(code: 'BSA', season: number): Promise<unknown> { return this.get(code, '/matches', season); }

  private async get(code: 'BSA', path: string, season?: number): Promise<unknown> {
    if (code !== 'BSA' || (season !== undefined && (!Number.isInteger(season) || season < 1900 || season > 9999))) throw new FootballDataError('football-data: consulta inválida.');
    const token = this.config.get<string>('FOOTBALL_DATA_API_TOKEN')?.trim();
    if (!token) throw new FootballDataError('FOOTBALL_DATA_API_TOKEN não configurado.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://api.football-data.org/v4/competitions/' + code + path + (season === undefined ? '' : '?season=' + season), {
        headers: { 'X-Auth-Token': token }, signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        const messages: Record<number, string> = { 401: 'token inválido (401)', 403: 'acesso negado (403)', 404: 'recurso não encontrado (404)', 429: 'limite de requisições atingido (429); tente novamente mais tarde' };
        throw new FootballDataError('football-data: ' + (messages[response.status] ?? (response.status >= 500 ? 'provedor indisponível (5xx)' : 'falha HTTP')) + '.');
      }
      try { return await response.json(); } catch {
        if (controller.signal.aborted) throw new FootballDataError('football-data: timeout.');
        throw new FootballDataError('football-data: resposta inválida.');
      }
    } catch (error) {
      if (error instanceof FootballDataError) throw error;
      throw new FootballDataError(controller.signal.aborted ? 'football-data: timeout.' : 'football-data: falha de conexão.');
    } finally { clearTimeout(timer); }
  }
}
