import { INestApplication, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';
import { OptionalJwtAuthGuard } from '../src/auth/optional-jwt-auth.guard';
import { PointFantasyController } from '../src/point-fantasy/point-fantasy.controller';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';

describe('historical ranking (memory only; no database writes)', () => {
  let db: any, competition: any, round: any, entries: any[], cartola: any, scoring: any, service: PointFantasyService;
  beforeEach(() => {
    competition = { id: 1, temporada: 2026, rodada: 31, status: 'PUBLICADA',
      fimInscricao: new Date(0), fechamentoDefinitivoEm: new Date(1000),
      partidas: [{ status: 'EM_ANDAMENTO', inicioReal: null, inicioPrevisto: new Date(0) }] };
    round = { revisaoAtual: 2n, revisaoValidada: null, hashConteudoAtual: 'a'.repeat(64), estado: 'OBSERVANDO' };
    entries = [5, 6, 7].map((id, i) => ({ id, usuarioId: id, versao: 3, formacao: '4-3-3',
      nomePublico: 'Public team ' + id, identidade: { identificadorPublico: 'ABC', nomeBase: 'Public team' },
      sequencial: i + 1, usuario: { fantasyBrasaoId: 'v1:c2:p2' },
      resultado: { competicaoId: 1, temporada: 2026, rodada: 31, revisao: 2n, hashFonte: round.hashConteudoAtual,
        versaoEscalacao: 3, versaoMotor: '3F-1', total: new Prisma.Decimal(['34.41', '30.31', '85.51'][i]) } }));
    db = {
      fantasyCompeticao: { findFirst: jest.fn(async () => competition) },
      fantasyApuracaoRodada: { findUnique: jest.fn(async () => round) },
      fantasyEscalacao: { findMany: jest.fn(async () => entries), count: jest.fn(async () => entries.length) },
      rodadaProcessamento: { findFirst: jest.fn(() => { throw Error('NO_TRADITIONAL_HISTORY_READ'); }) },
    };
    db.$transaction = jest.fn(async (fn: any) => fn(db));
    cartola = {
      getMarketStatus: jest.fn(async () => ({ value: { temporada: 2026, rodada_atual: 35, status_mercado: 1 }, stale: false })),
      getScoredAthletes: jest.fn(() => { throw Error('NO_SCORE_PROVIDER_READ'); }),
      getMatchesByRound: jest.fn(() => { throw Error('NO_MATCH_PROVIDER_READ'); }),
    };
    scoring = { previewCartolaCompetition: jest.fn(async () => ({
      partidas: ['EM_ANDAMENTO'], items: entries.map(e => ({ escalacaoId: e.id, versaoEscalacao: e.versao, total: '1' })),
      cacheDesatualizado: false,
    })) };
    service = new PointFantasyService(db, cartola, scoring);
  });

  it('reads R31 stored results as definitive against official R35, independent of processing status', async () => {
    const before = entries.map(e => e.resultado.total.toFixed());
    const result = await service.ranking(1, { page: 1, limit: 50 }, 6);
    expect(result.estadoPontuacao).toBe('DEFINITIVO');
    expect(result.items.map(i => [i.escalacaoId, i.posicao, i.pontuacao])).toEqual([[7, 1, '85.51'], [5, 2, '34.41'], [6, 3, '30.31']]);
    expect(result.items[2].meuTime).toBe(true);
    expect(result.items.every(i => i.brasaoId === 'v1:c2:p2')).toBe(true);
    expect(entries.map(e => e.resultado.total.toFixed())).toEqual(before);
    expect(cartola.getMarketStatus).toHaveBeenCalledTimes(1);
    expect(scoring.previewCartolaCompetition).not.toHaveBeenCalled();
    expect(cartola.getScoredAthletes).not.toHaveBeenCalled();
    expect(cartola.getMatchesByRound).not.toHaveBeenCalled();
    expect(db.rodadaProcessamento.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/hashFonte|revisaoAtual|usuarioId|auditoria/);
  });

  it('keeps the immediately preceding round provisional while its correction window is open', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: 32 }, stale: false });
    expect((await service.ranking(1, { page: 1, limit: 50 })).estadoPontuacao).toBe('PROVISORIO');
  });

  it('preserves Ranking scores when Cartola advances before Fantasy apuração exists', async () => {
    competition.rodada = 35;
    const totals = ['34.41', '30.31', '85.51'];
    scoring.previewCartolaCompetition
      .mockResolvedValueOnce({ partidas: ['EM_ANDAMENTO'], cacheDesatualizado: false,
        items: entries.map((entry, index) => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao,
          total: totals[index], missing: [] })) })
      .mockResolvedValueOnce({ partidas: ['ENCERRADA'], cacheDesatualizado: false,
        items: entries.map((entry, index) => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao,
          total: totals[index], missing: [] })) });
    cartola.getMarketStatus.mockResolvedValueOnce({ value: { temporada: 2026, rodada_atual: 35, status_mercado: 1 }, stale: false });

    const live = await service.ranking(1, { page: 1, limit: 50 });

    expect(live.estadoPontuacao).toBe('AO_VIVO');
    expect(live.items.map(item => item.pontuacao)).toEqual(['85.51', '34.41', '30.31']);

    round = null;
    cartola.getMarketStatus.mockResolvedValueOnce({ value: { temporada: 2026, rodada_atual: 36, status_mercado: 1 }, stale: false });
    const afterRoundAdvance = await service.ranking(1, { page: 1, limit: 50 });

    expect(afterRoundAdvance.estadoPontuacao).toBe('PROVISORIO');
    expect(afterRoundAdvance.items.map(item => [item.escalacaoId, item.posicao, item.pontuacao])).toEqual([
      [7, 1, '85.51'], [5, 2, '34.41'], [6, 3, '30.31'],
    ]);
    expect(scoring.previewCartolaCompetition).toHaveBeenCalledTimes(2);
  });

  it('serves previous-round provisional scores through the public Ranking endpoint', async () => {
    let app: INestApplication | undefined;
    competition.rodada = 35;
    round = null;
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: 36, status_mercado: 1 }, stale: false });
    scoring.previewCartolaCompetition.mockResolvedValue({ partidas: ['ENCERRADA'], cacheDesatualizado: false,
      items: entries.map((entry, index) => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao,
        total: ['34.41', '30.31', '85.51'][index], missing: [] })) });
    const module = await Test.createTestingModule({ controllers: [PointFantasyController], providers: [
      OptionalJwtAuthGuard, { provide: PointFantasyService, useValue: service }, { provide: AuthService, useValue: {} },
    ] }).compile();

    try {
      app = module.createNestApplication({ logger: false });
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
      await app.listen(0, '127.0.0.1');
      const response = await fetch(`${await app.getUrl()}/point-fantasy/competicoes/1/ranking?page=1&limit=50`);
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ competicaoId: 1, estadoPontuacao: 'PROVISORIO', total: 3 });
      expect(body.items.map((item: any) => [item.escalacaoId, item.posicao, item.pontuacao])).toEqual([
        [7, 1, '85.51'], [5, 2, '34.41'], [6, 3, '30.31'],
      ]);
    } finally { await app?.close(); }
  });

  it('keeps the previous-round fallback pending when preview data is incomplete', async () => {
    competition.rodada = 35;
    round = null;
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: 36, status_mercado: 1 }, stale: false });
    scoring.previewCartolaCompetition.mockResolvedValue({ partidas: ['ENCERRADA'], cacheDesatualizado: false,
      items: entries.map(entry => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao, total: '10', missing: [900] })) });

    const result = await service.ranking(1, { page: 1, limit: 50 });

    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
  });

  it.each([
    ['Cartola market closed', 32, 2],
    ['more than one round old', 33, 1],
  ])('does not use the preview fallback when the official correction window is closed: %s', async (_reason, currentRound, marketStatus) => {
    round = null;
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: currentRound, status_mercado: marketStatus }, stale: false });

    const result = await service.ranking(1, { page: 1, limit: 50 });

    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result).toMatchObject({ motivoPendencia: 'APURACAO_INDISPONIVEL' });
    expect(scoring.previewCartolaCompetition).not.toHaveBeenCalled();
  });

  it('allows an explicitly validated previous round to retain its definitive status', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: 32 }, stale: false });
    round.estado = 'VALIDADA'; round.revisaoValidada = 2n;
    expect((await service.ranking(1, { page: 1, limit: 50 })).estadoPontuacao).toBe('DEFINITIVO');
  });

  it('compares seasons before round numbers', async () => {
    competition.temporada = 2025; entries.forEach(e => { e.resultado.temporada = 2025; });
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: 1 }, stale: false });
    expect((await service.ranking(1, { page: 1, limit: 50 })).estadoPontuacao).toBe('DEFINITIVO');
  });

  it.each(['current', 'future round', 'future season'])('preserves the live path for %s', async scenario => {
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: 31 }, stale: false });
    if (scenario === 'future round') competition.rodada = 32;
    if (scenario === 'future season') competition.temporada = 2027;
    const result = await service.ranking(1, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('AO_VIVO');
    expect(scoring.previewCartolaCompetition).toHaveBeenCalledTimes(1);
  });

  it('does not expose future teams scores or rival formations before their registration closes', async () => {
    competition.rodada = 36; competition.fimInscricao = new Date(Date.now() + 60000);
    competition.fechamentoDefinitivoEm = null;
    competition.partidas = [{ status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date(Date.now() + 120000) }];
    const result = await service.ranking(1, { page: 1, limit: 50 }, 6);
    expect(result.estadoPontuacao).toBe('NAO_INICIADA');
    expect(result.items.map(i => i.formacao)).toEqual([null, '4-3-3', null]);
    expect(result.items.every(i => i.pontuacao === null && i.posicao === null)).toBe(true);
    expect(scoring.previewCartolaCompetition).not.toHaveBeenCalled();
  });

  it('preserves ties across pages, null scores and real zero/negative scores', async () => {
    entries[0].resultado.total = new Prisma.Decimal('85.510');
    const first = await service.ranking(1, { page: 1, limit: 1 });
    const second = await service.ranking(1, { page: 2, limit: 1 });
    const third = await service.ranking(1, { page: 3, limit: 1 });
    expect([first.items[0].posicao, second.items[0].posicao, third.items[0].posicao]).toEqual([1, 1, 3]);
    expect((await service.ranking(1, { page: 4, limit: 1 })).items).toEqual([]);
    entries[0].resultado.total = new Prisma.Decimal('0'); entries[1].resultado.total = new Prisma.Decimal('-2');
    const complete = await service.ranking(1, { page: 1, limit: 50 });
    expect(complete.items.map(i => i.pontuacao)).toEqual(['85.51', '0', '-2']);
    entries[1].resultado.total = null;
    const incomplete = await service.ranking(1, { page: 1, limit: 50 });
    expect(incomplete.estadoPontuacao).toBe('PENDENTE');
    expect(incomplete).toMatchObject({ motivoPendencia: 'PONTUACAO_INDISPONIVEL' });
    expect(incomplete.items.map(i => i.pontuacao)).toEqual(['85.51', '0', null]);
    expect(incomplete.items.every(i => i.posicao === null)).toBe(true);
  });

  it.each(['revision', 'hash', 'lineup version', 'competition', 'season', 'round', 'engine'])('does not reuse an inconsistent %s', async reason => {
    const result = entries[0].resultado;
    if (reason === 'revision') result.revisao = 1n;
    if (reason === 'hash') result.hashFonte = 'b'.repeat(64);
    if (reason === 'lineup version') result.versaoEscalacao = 2;
    if (reason === 'competition') result.competicaoId = 99;
    if (reason === 'season') result.temporada = 2025;
    if (reason === 'round') result.rodada = 30;
    if (reason === 'engine') result.versaoMotor = 'old';
    const response = await service.ranking(1, { page: 1, limit: 50 });
    expect(response.estadoPontuacao).toBe('PENDENTE');
    expect(response).toMatchObject({ motivoPendencia: 'RESULTADO_DESATUALIZADO' });
    expect(response.items.find(i => i.escalacaoId === 5)?.pontuacao).toBeNull();
    expect(response.items.every(i => i.posicao === null)).toBe(true);
    expect(scoring.previewCartolaCompetition).not.toHaveBeenCalled();
  });

  it.each(['missing round', 'missing result', 'review', 'unvalidated revision', 'empty'])('identifies historical pending reason: %s', async scenario => {
    if (scenario === 'missing round') round = null;
    if (scenario === 'missing result') entries[0].resultado = null;
    if (scenario === 'review') round.estado = 'EM_REVISAO';
    if (scenario === 'unvalidated revision') round.revisaoValidada = 1n;
    if (scenario === 'empty') entries = [];
    const reasons: Record<string, string> = { 'missing round': 'APURACAO_INDISPONIVEL', 'missing result': 'RESULTADO_AUSENTE',
      review: 'APURACAO_EM_REVISAO', 'unvalidated revision': 'REVISAO_EM_VALIDACAO', empty: 'SEM_INSCRICOES' };
    const result = await service.ranking(1, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result).toMatchObject({ motivoPendencia: reasons[scenario] });
  });

  it('does not declare definitive from a stale official market reference', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { temporada: 2026, rodada_atual: 35 }, stale: true });
    const result = await service.ranking(1, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PROVISORIO');
    expect(result).toMatchObject({ cacheDesatualizado: true });
    expect(result.items[0].pontuacao).toBe('85.51');
  });

  it.each([null, { rodada_atual: 35 }, { temporada: 2026, rodada_atual: 0 }])('does not infer history from an invalid reference: %p', async value => {
    cartola.getMarketStatus.mockResolvedValue({ value, stale: false });
    expect((await service.ranking(1, { page: 1, limit: 50 })).estadoPontuacao).toBe('AO_VIVO');
  });

  it('retains live source failure behavior when the market is unavailable', async () => {
    cartola.getMarketStatus.mockRejectedValue(new ServiceUnavailableException());
    scoring.previewCartolaCompetition.mockRejectedValue(new ServiceUnavailableException());
    const result = await service.ranking(1, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(i => i.pontuacao === null)).toBe(true);
  });

  it('serves historical ranking through the real controller with a read-only memory fixture', async () => {
    let app: INestApplication | undefined;
    const module = await Test.createTestingModule({ controllers: [PointFantasyController], providers: [
      OptionalJwtAuthGuard, { provide: PointFantasyService, useValue: service }, { provide: AuthService, useValue: {} },
    ] }).compile();
    try {
      app = module.createNestApplication({ logger: false });
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
      await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
      const response = await fetch(origin + '/point-fantasy/competicoes/1/ranking?page=2&limit=1');
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await response.json() as any;
      expect(body).toMatchObject({ estadoPontuacao: 'DEFINITIVO', page: 2, limit: 1, total: 3 });
      expect(body.items[0]).toMatchObject({ escalacaoId: 5, posicao: 2, pontuacao: '34.41' });
    } finally { await app?.close(); }
  });
});
