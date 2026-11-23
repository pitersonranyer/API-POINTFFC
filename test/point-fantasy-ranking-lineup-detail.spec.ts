import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { OptionalJwtAuthGuard } from '../src/auth/optional-jwt-auth.guard';
import { PointFantasyController } from '../src/point-fantasy/point-fantasy.controller';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';

describe('POINT Fantasy public ranking lineup detail', () => {
  const setup = () => {
    const athlete = { id: 10, catalogoId: 3, atletaIdExterno: 1010, clubeIdExterno: 263,
      posicaoId: 1, apelido: 'Goleiro', statusId: 7, precoCartola: '10' };
    const lineup: any = { id: 18, competicaoId: 7, usuarioId: 4, status: 'INSCRITA', confirmadaEm: new Date(),
      versao: 2, nomePublico: 'Time A', sequencial: 1, formacao: '4-3-3', capitaoAtletaId: 10,
      reservaMagoAtletaId: 20, usuario: { fantasyBrasaoId: null }, identidade: null,
      atletas: [{ id: 1, catalogoAtletaId: 10, papel: 'TITULAR', atleta: athlete }] };
    const competition: any = { id: 7, status: 'PUBLICADA', temporada: 2026, rodada: 35,
      fimInscricao: new Date(0), fechamentoDefinitivoEm: null,
      catalogo: { referencias: { clubes: { '263': { nome: 'Botafogo' } }, posicoes: {}, partidas: [] } },
      partidas: [{ status: 'ENCERRADA', inicioReal: new Date(0), inicioPrevisto: new Date(0) }] };
    const db: any = { fantasyCompeticao: { findFirst: jest.fn(async () => competition) },
      fantasyEscalacao: { findFirst: jest.fn(async () => lineup), findMany: jest.fn(async () => [lineup]) },
      fantasyApuracaoRodada: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (action: any) => action(db)) };
    const scoring: any = { previewCartolaLineup: jest.fn(async () => ({ total: '12.5', missing: [],
      cacheDesatualizado: false, partidas: ['ENCERRADA'],
      atletas: [{ catalogoAtletaId: 10, pontuacaoCartola: '6.25', scouts: { G: 1 } }],
      contributions: [{ starter: 10, athlete: 10, multiplier: 2, points: '12.5' }], substitutions: [] })) };
    const service = new PointFantasyService(db, {} as any, scoring);
    jest.spyOn(service, 'ranking').mockResolvedValue({ competicaoId: 7, estadoPontuacao: 'PROVISORIO', detalhesPublicosLiberados: true,
      items: [{ escalacaoId: 18, posicao: 1, pontuacao: '12.5', nomePublico: 'Time A',
        brasaoId: 'default', identidade: null, capitaoNome: null, formacao: '4-3-3', meuTime: false }], total: 1, page: 1, limit: 50 });
    return { service, scoring, competition, db };
  };

  it('exposes only a registered lineup after lock with official preview scouts and substitutions', async () => {
    const { service } = setup();
    const result = await service.rankingLineup(7, 18);
    expect(result.ranking).toMatchObject({ estadoPontuacao: 'PROVISORIO', posicao: 1, pontuacao: '12.5' });
    expect(result.escalacao.atletas[0]).toMatchObject({ papel: 'TITULAR', clube: { nome: 'Botafogo' } });
    expect(result.pontuacao).toMatchObject({ fonte: 'PREVIEW_CARTOLA', total: '12.5',
      atletas: [expect.objectContaining({ scouts: { G: 1 } })] });
    expect(JSON.stringify(result)).not.toContain('usuarioId');
  });

  it('does not expose a rival lineup before registration closes', async () => {
    const { service, competition } = setup();
    competition.fimInscricao = new Date(Date.now() + 60_000);
    competition.partidas = [{ status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date(Date.now() + 120_000) }];
    await expect(service.rankingLineup(7, 18)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('enforces the deadline on direct HTTP requests even when a match is marked as started', async () => {
    const { service, competition, db, scoring } = setup();
    competition.fimInscricao = new Date(Date.now() + 60_000);
    const module = await Test.createTestingModule({ controllers: [PointFantasyController], providers: [
      OptionalJwtAuthGuard, { provide: PointFantasyService, useValue: service }, { provide: AuthService, useValue: {} },
    ] }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const url = `${await app.getUrl()}/point-fantasy/competicoes/7/ranking/18`;
      expect((await fetch(url)).status).toBe(404);
      expect(db.fantasyEscalacao.findFirst).not.toHaveBeenCalled();
      expect(scoring.previewCartolaLineup).not.toHaveBeenCalled();

      competition.fimInscricao = new Date(0);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        escalacao: { atletas: [expect.objectContaining({ catalogoAtletaId: 10 })] },
        pontuacao: { atletas: [expect.objectContaining({ scouts: { G: 1 } })], substituicoes: [] },
      });
    } finally { await app.close(); }
  });
});
