import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RankingCompeticaoController } from '../src/ligas-competicoes/ranking-competicao.controller';
import { RankingCompeticaoService } from '../src/ligas-competicoes/ranking-competicao.service';

describe('GET /competicoes/:id/ranking', () => {
  let app: INestApplication;
  let base: string;
  const service = { consultar: jest.fn(), atualizarPontuacoes: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [RankingCompeticaoController], providers: [
      { provide: RankingCompeticaoService, useValue: service },
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    service.consultar.mockResolvedValue({ competicaoId: 1, nomeCompeticao: 'POINT FFC - Rodada 27',
      quantidadeParticipantes: 0, ranking: [] });
  });
  afterAll(() => app.close());

  it('e publico e retorna contrato do ranking', async () => {
    const response = await fetch(`${base}/competicoes/1/ranking`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ competicaoId: 1, nomeCompeticao: 'POINT FFC - Rodada 27',
      quantidadeParticipantes: 0, ranking: [] });
    expect(service.consultar).toHaveBeenCalledWith(1);
  });

  it.each(['0', 'abc', '1.5', '4294967296'])('rejeita ID invalido: %s', async id => {
    expect((await fetch(`${base}/competicoes/${id}/ranking`)).status).toBe(400);
    expect(service.consultar).not.toHaveBeenCalled();
  });

  it('nao expoe rota de atualizacao', async () => {
    expect((await fetch(`${base}/competicoes/1/ranking`, { method: 'POST' })).status).toBe(404);
    expect(service.atualizarPontuacoes).not.toHaveBeenCalled();
  });
});
