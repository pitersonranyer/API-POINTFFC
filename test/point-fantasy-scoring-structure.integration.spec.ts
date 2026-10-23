import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
// CommonJS operational helpers deliberately have no application bootstrap.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfill, isolatedUrl } = require('../scripts/point-fantasy-scoring-backfill.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fingerprint } = require('../scripts/point-fantasy-schema-read.cjs');

const urls = [process.env.POINT_FANTASY_SCORING_A_URL, process.env.POINT_FANTASY_SCORING_B_URL].filter(Boolean) as string[];
const suite = urls.length === 2 ? describe : describe.skip;
suite.each(urls.length ? urls : ['not configured'])('current scoring isolated scenario %#', url => {
  let db: PrismaClient;
  let season = 64000;
  const hash = 'a'.repeat(64);
  const athlete = {
    atletaIdCartola: 1, clubeIdCartola: null, posicaoId: 6,
    estadoClube: 'AUSENTE' as const, estadoPosicao: 'VALOR' as const,
    pontuacao: new Prisma.Decimal('8.030000000000001'), pontuacaoTokenOriginal: '8.030000000000001',
    estadoPontuacao: 'VALOR' as const, entrouEmCampo: false,
    estadoParticipacao: 'VALOR' as const, participacaoObservada: 'INFORMADA_FALSE' as const,
    scouts: { Z: '1', A: '-2.5' }, estadoScouts: 'VALOR' as const, hashConteudo: hash,
  };
  const collection = (rodadaId: number) => ({
    rodadaId, operacaoId: randomUUID(), endpoint: 'LOCAL_TEST', modeloPersistencia: 'ATUAL' as const,
    estado: 'SUCESSO' as const, concluidaEm: new Date(), recebidaEm: new Date(),
    revisaoBase: 0n, revisaoResultante: 1n, resultadoAplicacao: 'APLICADA' as const,
    hashConteudo: hash, fonte: 'TEST', versaoNormalizador: 'test-v1',
    qtdRecebidos: 1, qtdInseridos: 1, qtdAlterados: 0, qtdOmitidos: 0,
  });
  async function context(round: number) {
    const r = await db.fantasyApuracaoRodada.create({ data: { temporada: season, rodada: round } });
    const c = await db.fantasyPontuacaoColeta.create({ data: collection(r.id) });
    const a = await db.fantasyPontuacaoAtleta.create({ data: { ...athlete, temporada: season, rodada: round,
      apuracaoId: r.id, coletaAlteracaoId: c.id, revisaoAlteracao: 1n,
      presenteNaUltimaLista: true, versaoNormalizador: 'test-v1' } });
    return { r, c, a };
  }
  beforeAll(async () => {
    isolatedUrl(url);
    db = new PrismaClient({ datasources: { db: { url } }, log: [] });
    while (await db.fantasyApuracaoRodada.count({ where: { temporada: season } })) season--;
  });
  afterAll(async () => { await db?.$disconnect(); });

  it('preserves 275 exact rows, 20 coaches, decimals, tokens, scouts and three legacy collections', async () => {
    const rows = await db.fantasyPontuacaoAtleta.findMany({ where: { temporada: 2026, rodada: 31 } });
    const old = await db.fantasyPontuacaoAtletaSnapshot.findMany({ where: { snapshotId: 1 } });
    expect(rows).toHaveLength(275); expect(old).toHaveLength(275);
    expect(rows.filter(a => a.posicaoId === 6)).toHaveLength(20);
    for (const row of rows) {
      const source = old.find(a => a.atletaIdCartola === row.atletaIdCartola)!;
      for (const key of ['clubeIdCartola','posicaoId','estadoClube','estadoPosicao','estadoPontuacao',
        'pontuacaoTokenOriginal','estadoParticipacao','entrouEmCampo','participacaoObservada','estadoScouts','scouts','hashConteudo'] as const) {
        expect(row[key]).toEqual(source[key]);
      }
      expect(row.pontuacao?.equals(source.pontuacao!)).toBe(true);
      expect(row.presenteNaUltimaLista).toBe(true);
    }
    const sums = await db.$queryRaw<Array<{ atual: string; legado: string }>>`SELECT
      (SELECT CAST(SUM(PONTUACAO) AS CHAR) FROM FANTASY_PONTUACAO_ATLETA WHERE TEMPORADA=2026 AND RODADA=31) AS atual,
      (SELECT CAST(SUM(PONTUACAO) AS CHAR) FROM FANTASY_PONTUACAO_ATLETA_SNAPSHOT WHERE SNAPSHOT_ID=1) AS legado`;
    expect(sums[0].atual).toBe(sums[0].legado);
    expect(sums[0].atual).toBe('1169.590000000000001000');
    expect(rows.filter(a => a.pontuacao?.isZero())).toHaveLength(28);
    expect(rows.filter(a => a.pontuacao?.isNegative())).toHaveLength(17);
    const legacy = await db.fantasyPontuacaoColeta.findMany({ where: { id: { in: [1,2,3] } }, orderBy: { id: 'asc' } });
    expect(legacy.map(c => c.estado)).toEqual(['FALHA_REDE','SUCESSO','SUCESSO']);
    expect(legacy.every(c => c.modeloPersistencia === 'SNAPSHOT_LEGADO')).toBe(true);
    const round = await db.fantasyApuracaoRodada.findUniqueOrThrow({ where: { temporada_rodada: { temporada: 2026, rodada: 31 } } });
    expect(round).toMatchObject({ estado: 'OBSERVANDO', revisaoAtual: 1n, revisaoValidada: null, validadaEm: null });
  });
  it('second backfill changes no row, timestamp, counter or history', async () => {
    const before = await fingerprint(db);
    expect(await backfill(url, 2026, 31)).toMatchObject({ reused: true, total: 275n });
    expect(await fingerprint(db)).toEqual(before);
  });
  it('accepts current success without snapshot and preserves exact token and observed false', async () => {
    const { c, a } = await context(1);
    expect(c.snapshotId).toBeNull(); expect(a.posicaoId).toBe(6);
    expect(a.pontuacao?.toFixed()).toBe('8.030000000000001');
    expect(a.pontuacaoTokenOriginal).toBe('8.030000000000001');
    expect(a.entrouEmCampo).toBe(false); expect(a.presenteNaUltimaLista).toBe(true);
    expect(a.scouts).toEqual({ A: '-2.5', Z: '1' });
  });
  it('distinguishes absent, null, zero and negative; rejects contradictory field states', async () => {
    const { r, c } = await context(2);
    for (const [index, state] of (['AUSENTE','NULO','VALOR','VALOR'] as const).entries()) {
      const point = index < 2 ? null : new Prisma.Decimal(index === 2 ? '0' : '-1.3');
      const row = await db.fantasyPontuacaoAtleta.create({ data: { ...athlete, atletaIdCartola: index + 2,
        temporada: season, rodada: 2, apuracaoId: r.id, coletaAlteracaoId: c.id, revisaoAlteracao: 1n,
        presenteNaUltimaLista: false, versaoNormalizador: 'test-v1', estadoPontuacao: state,
        pontuacao: point, pontuacaoTokenOriginal: point?.toFixed() ?? null } });
      expect(row.estadoPontuacao).toBe(state); expect(row.pontuacao?.toFixed() ?? null).toBe(point?.toFixed() ?? null);
    }
    await expect(db.$executeRaw`UPDATE FANTASY_PONTUACAO_ATLETA SET ESTADO_PONTUACAO='NULO'
      WHERE TEMPORADA=${season} AND RODADA=2 AND ATLETA_ID_CARTOLA=1`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE FANTASY_PONTUACAO_ATLETA SET ESTADO_SCOUTS='NULO'
      WHERE TEMPORADA=${season} AND RODADA=2 AND ATLETA_ID_CARTOLA=1`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE FANTASY_PONTUACAO_ATLETA SET PARTICIPACAO_OBSERVADA='INFORMADA_TRUE'
      WHERE TEMPORADA=${season} AND RODADA=2 AND ATLETA_ID_CARTOLA=1`).rejects.toThrow();
  });
  it('rejects cross-round and cross-season owners and duplicate athlete identity', async () => {
    const { r, c } = await context(3); const other = await context(4);
    const data = { ...athlete, temporada: season, rodada: 3, apuracaoId: r.id, coletaAlteracaoId: c.id,
      revisaoAlteracao: 1n, presenteNaUltimaLista: true, versaoNormalizador: 'test-v1' };
    await expect(db.fantasyPontuacaoAtleta.create({ data })).rejects.toThrow();
    await expect(db.fantasyPontuacaoAtleta.create({ data: { ...data, atletaIdCartola: 2, coletaAlteracaoId: other.c.id } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoAtleta.create({ data: { ...data, temporada: season - 1 } })).rejects.toThrow();
    await expect(db.fantasyApuracaoRodada.update({ where: { id: r.id }, data: { revisaoAtual: 1n,
      hashConteudoAtual: hash, versaoNormalizador: 'test-v1', ultimaColetaAplicadaId: other.c.id } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoColeta.delete({ where: { id: c.id } })).rejects.toThrow();
    await expect(db.fantasyApuracaoRodada.delete({ where: { id: r.id } })).rejects.toThrow();
  });
  it('enforces current/legacy success, revision, terminal and failure invariants', async () => {
    const r = await db.fantasyApuracaoRodada.create({ data: { temporada: season, rodada: 5 } });
    const data = collection(r.id);
    await expect(db.fantasyPontuacaoColeta.create({ data: { ...data, revisaoResultante: null } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoColeta.create({ data: { ...data, revisaoResultante: 3n } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoColeta.create({ data: { ...data, hashConteudo: null } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoColeta.create({ data: { ...data, concluidaEm: null } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoColeta.create({ data: { ...data, snapshotId: 1 } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoColeta.create({ data: { rodadaId: r.id, operacaoId: randomUUID(), endpoint: 'TEST', estado: 'SUCESSO', concluidaEm: new Date() } })).rejects.toThrow();
    await expect(db.fantasyPontuacaoColeta.create({ data: { ...data, estado: 'FALHA_REDE' } })).rejects.toThrow();
    await db.fantasyPontuacaoColeta.create({ data: { ...data, revisaoBase: 1n, revisaoResultante: 1n,
      resultadoAplicacao: 'SEM_ALTERACAO', qtdInseridos: 0 } });
    await db.fantasyPontuacaoColeta.create({ data: { rodadaId: r.id, operacaoId: randomUUID(), endpoint: 'TEST',
      modeloPersistencia: 'ATUAL', estado: 'FALHA_REDE', concluidaEm: new Date(), resultadoAplicacao: 'REJEITADA' } });
    await expect(db.fantasyApuracaoRodada.update({ where: { id: r.id }, data: { estado: 'VALIDADA' } })).rejects.toThrow();
  });
  it('selects last accepted A after A -> B -> A rather than largest snapshot version', async () => {
    const r = await db.fantasyApuracaoRodada.create({ data: { temporada: season, rodada: 6, ultimaVersaoSnapshot: 2 } });
    const snapshots = [];
    for (const version of [1,2]) {
      const s = await db.fantasyPontuacaoSnapshot.create({ data: { rodadaId: r.id, versao: version,
        hashConteudo: String(version).repeat(64), versaoNormalizador: 'test-v1', fonte: 'CARTOLA_PONTUADOS',
        endpointOrigem: 'LOCAL_TEST', payloadOriginal: '{}', hashPayload: hash, coletadoEm: new Date() } });
      await db.fantasyPontuacaoAtletaSnapshot.create({ data: { ...athlete, snapshotId: s.id,
        pontuacao: new Prisma.Decimal(version === 1 ? '-1.3' : '0'), pontuacaoTokenOriginal: version === 1 ? '-1.3' : '0' } });
      snapshots.push(s);
    }
    for (const [index, s] of [snapshots[0],snapshots[1],snapshots[0]].entries()) {
      await db.fantasyPontuacaoColeta.create({ data: { rodadaId: r.id, snapshotId: s.id, operacaoId: randomUUID(),
        endpoint: 'LOCAL_TEST', estado: 'SUCESSO', concluidaEm: new Date(), fence: BigInt(index + 1) } });
    }
    expect(await backfill(url, season, 6)).toMatchObject({ snapshotId: snapshots[0].id, total: 1n });
    const a = await db.fantasyPontuacaoAtleta.findFirstOrThrow({ where: { apuracaoId: r.id } });
    expect(a.pontuacao?.toFixed()).toBe('-1.3');
    expect(await backfill(url, season, 6)).toMatchObject({ reused: true });
    await db.fantasyPontuacaoColeta.create({ data: { rodadaId: r.id, snapshotId: snapshots[1].id, operacaoId: randomUUID(),
      endpoint: 'LOCAL_TEST', estado: 'SUCESSO', concluidaEm: new Date(), fence: 4n } });
    await expect(backfill(url, season, 6)).rejects.toThrow('BACKFILL_BASE_CHANGED');
  });
  it('refuses principal, remote URLs and rounds with an active lease', async () => {
    expect(() => isolatedUrl('mysql://test:test@127.0.0.1:3306/fantasy_point_do_jogador')).toThrow('ISOLATED_LOCAL_SCHEMA_REQUIRED');
    expect(() => isolatedUrl('mysql://test:test@remote:3306/point_fantasy_observation_3b2_test_1')).toThrow();
    await db.fantasyApuracaoRodada.create({ data: { temporada: season, rodada: 7, lockToken: randomUUID(), lockAte: new Date() } });
    await expect(backfill(url, season, 7)).rejects.toThrow('QUIESCENT_OBSERVING_ROUND_REQUIRED');
  });
});
