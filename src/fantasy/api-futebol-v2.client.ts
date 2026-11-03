import { BadGatewayException, GatewayTimeoutException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type Registro = Record<string, unknown>;
export function registro(value: unknown): Registro {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadGatewayException('Resposta inválida do serviço de partidas');
  return value as Registro;
}

@Injectable()
export class ApiFutebolV2Client {
  private readonly cache = new Map<string, { expires: number; data: Registro }>();
  private readonly pending = new Map<string, Promise<Registro>>();
  private readonly statuses = new Map<number, string>();
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly config: ConfigService) {}

  detalhe(id: number) { return this.get(id, ''); }
  eventos(id: number) { return this.get(id, '/eventos'); }
  lances(id: number) { return this.get(id, '/lances'); }
  estatisticas(id: number) { return this.get(id, '/estatisticas'); }
  campeonato() { return this.get(0, '', '/campeonatos/1'); }
  rodadas() { return this.get(0, '', '/campeonatos/1/rodadas'); }
  rodada(numero: number) { return this.get(0, '', `/campeonatos/1/rodadas/${numero}?timezone=America%2FSao_Paulo`); }

  private setting(name: string, fallback: number): number {
    const value = Number(this.config.get(name) ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
  private ttl(id: number): number {
    const status = this.statuses.get(id);
    if (['finalizado', 'cancelado', 'abandonado', 'wo'].includes(status ?? '')) return this.setting('API_FUTEBOL_V2_TTL_FINAL_MS', 3600000);
    if (['andamento', 'suspenso'].includes(status ?? '')) return this.setting('API_FUTEBOL_V2_TTL_LIVE_MS', 60000);
    return this.setting('API_FUTEBOL_V2_TTL_PRE_MS', 300000);
  }
  private async get(id: number, suffix: string, agendaPath?: string): Promise<Registro> {
    const path = agendaPath ?? `/partidas/${id}${suffix}`;
    const cached = this.cache.get(path);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.data);
    let work = this.pending.get(path);
    if (!work) {
      work = this.request(path, id, suffix).then(data => {
        for (const [key, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(key);
        if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(path, { data, expires: Date.now() + (agendaPath ? this.agendaTtl(data) : this.ttl(id)) });
        return data;
      });
      this.pending.set(path, work);
    }
    try { return structuredClone(await work); }
    finally { if (this.pending.get(path) === work) this.pending.delete(path); }
  }

  private agendaTtl(data: Registro): number {
    const partidas = Array.isArray(data.partidas) ? data.partidas.map(registro) : [];
    if (partidas.length && partidas.every(p => ['finalizado', 'cancelado', 'abandonado', 'wo'].includes(String(p.status)))) return this.setting('API_FUTEBOL_V2_TTL_FINAL_MS', 3600000);
    if (data.status === 'andamento' || data.itens || partidas.some(p => ['andamento', 'suspenso'].includes(String(p.status)))) return this.setting('API_FUTEBOL_V2_TTL_LIVE_MS', 60000);
    return this.setting('API_FUTEBOL_V2_TTL_PRE_MS', 300000);
  }

  private async request(path: string, id: number, suffix: string): Promise<Registro> {
    const key = this.config.get<string>('API_FUTEBOL_V2_KEY')?.trim();
    if (!key) throw new ServiceUnavailableException('Serviço de partidas não configurado');
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.setting('API_FUTEBOL_V2_TIMEOUT_MS', 15000));
    try {
      if (Date.now() < this.blockedUntil) throw new ServiceUnavailableException('Limite do serviço de partidas atingido');
      const response = await fetch('https://api.api-futebol.com.br/v2' + path, {
        method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal, redirect: 'error',
      });
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 429 || (remaining !== null && Number(remaining) === 0)) {
        const retry = response.headers.get('retry-after');
        const retryAt = retry === null ? 0 : /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
        this.blockedUntil = Math.max(Date.now() + 1000, Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 60000,
          Number.isFinite(retryAt) ? retryAt : 0);
      }
      if (response.status === 404) throw new NotFoundException('Partida não encontrada');
      if ([401, 403, 429].includes(response.status) || response.status >= 500) throw new ServiceUnavailableException('Serviço de partidas indisponível');
      if (!response.ok) throw new BadGatewayException('Falha ao consultar o serviço de partidas');
      const body = registro(await response.json());
      // O envelope também informa consumo. Usa-o quando o proxy não repassa os headers.
      const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata as Registro : {};
      const quota = metadata.requisicoes && typeof metadata.requisicoes === 'object' ? metadata.requisicoes as Registro : {};
      if (quota.restantes === 0) {
        const metadataReset = typeof quota.reseta_em === 'number' ? quota.reseta_em * 1000 : 0;
        this.blockedUntil = Math.max(this.blockedUntil, metadataReset > Date.now() ? metadataReset : Date.now() + 60000);
      }
      if (id === 0) return Array.isArray(body.data) ? { itens: body.data } : registro(body.data);
      const data = registro(body.data);
      if (data.id !== id) throw new BadGatewayException('Identidade da partida divergente');
      if (!suffix) {
        registro(data.mandante); registro(data.visitante);
        if (typeof data.status !== 'string') throw new BadGatewayException('Resposta inválida do serviço de partidas');
        if (this.statuses.size >= 500) this.statuses.delete(this.statuses.keys().next().value!);
        this.statuses.set(id, data.status);
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new GatewayTimeoutException('Tempo limite do serviço de partidas excedido');
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException('Resposta ou conexão inválida do serviço de partidas');
    } finally { clearTimeout(timer); release(); }
  }
}
