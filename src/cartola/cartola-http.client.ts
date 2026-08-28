import { BadGatewayException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CartolaHttpClient {
  private readonly logger = new Logger(CartolaHttpClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('CARTOLA_API_URL').replace(/\/$/, '');
    this.timeoutMs = config.get<number>('CARTOLA_API_TIMEOUT_MS', 5000);
  }

  async get<T>(path: string, options?: { notFoundMessage?: string }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'FantasyPointBackend/1.0' },
        signal: controller.signal,
      });
      if (response.status === 404 && options?.notFoundMessage) throw new NotFoundException(options.notFoundMessage);
      if (!response.ok) {
        this.logger.error(`API Cartola respondeu HTTP ${response.status} em ${path}`);
        throw new BadGatewayException('A API do Cartola retornou uma resposta inválida');
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof NotFoundException) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error(`Timeout ao consultar API Cartola em ${path}`);
        throw new ServiceUnavailableException('A API do Cartola excedeu o tempo limite');
      }
      this.logger.error(`Falha ao consultar API Cartola em ${path}: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
      throw new BadGatewayException('Não foi possível consultar a API do Cartola');
    } finally { clearTimeout(timeout); }
  }
}
