import { Prisma } from '@prisma/client';
import { LineupService } from '../src/point-fantasy/lineups/lineup.service';
import { readResultDetail, readResultSummaries } from '../src/point-fantasy/lineups/lineup-result.read';
import { completeLineup } from './point-fantasy-lineup.fixture';

describe('Persisted lineup result read contract', () => {
  let db: any, c: any, lineup: any, result: any, round: any, service: LineupService;
  beforeEach(() => {
    const { athletes, selection } = completeLineup();
    c = { id: 1, temporada: 2026, rodada: 31, status: 'PUBLICADA', fechamentoDefinitivoEm: new Date(0) };
    round = { id: 1, revisaoAtual: 2n, hashConteudoAtual: 'hash' };
    lineup = { id: 5, usuarioId: 10, competicaoId: 1, status: 'INSCRITA', versao: 3,
      formacao: selection.formacao, capitaoAtletaId: 1, reservaMagoAtletaId: 13, identidade: null,
      nomePublico: 'Time 01', atletas: athletes.map(a => ({ catalogoAtletaId: a.id, atleta: a,
        papel: a.id <= 11 ? 'TITULAR' : a.id === 12 ? 'TECNICO' : 'RESERVA' })) };
    result = { competicaoId: 1, temporada: 2026, rodada: 31, revisao: 2n, hashFonte: 'hash',
      versaoEscalacao: 3, versaoMotor: '3F-1', total: new Prisma.Decimal('34.41'), atualizadoEm: new Date(0),
      auditoria: { escalacaoId: 5, versaoEscalacao: 3, total: '34.41',
        contributions: Array.from({ length: 12 }, (_, i) => ({ starter: i + 1, athlete: i === 0 ? 13 : i + 1,
          multiplier: i === 0 ? 2 : 1, points: i === 0 ? '0' : i === 1 ? '4.41' : '3' })),
        substitutions: [{ out: 1, in: 13, kind: 'COMUM', multiplier: 2, officialPoints: '-0.2', contribution: '0' }],
        fontes: [{ catalogoAtletaId: 1, origem: 'NAO_PARTICIPACAO_INFERIDA_CARTOLA' }],
        evidenciaAusencias: { eligible: true, revision: '2', sourceHash: 'hash' }, usuarioId: 10, motivo: 'private admin' } };
    db = {
      usuario: { findUnique: jest.fn().mockResolvedValue({ status: 'ATIVO' }) },
      fantasyCompeticao: { findUnique: jest.fn(async () => c) },
      fantasyApuracaoRodada: { findUnique: jest.fn(async () => round) },
      fantasyEscalacaoResultado: { findUnique: jest.fn(async () => result) },
      fantasyPontuacaoAtleta: { findMany: jest.fn(async () => [{ atletaIdCartola: 1013, clubeIdCartola: 263, posicaoId: 1,
        estadoClube: 'VALOR', estadoPosicao: 'VALOR', estadoPontuacao: 'VALOR', pontuacao: new Prisma.Decimal('-0.2'),
        estadoParticipacao: 'VALOR', entrouEmCampo: true, presenteNaUltimaLista: true, revisaoAlteracao: 2n }]) },
      fantasyEscalacao: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.id !== lineup.id) return null;
          if (where.usuarioId !== undefined) return where.usuarioId === lineup.usuarioId ? lineup : null;
          return lineup.status === where.status && c.status === where.competicao.status && c.fechamentoDefinitivoEm
            && c.fechamentoDefinitivoEm <= where.competicao.fechamentoDefinitivoEm.lte ? lineup : null;
        }),
        findMany: jest.fn(async ({ where, select }: any) => select ? [{ id: 5, versao: 3, resultado: result }]
          : where.usuarioId === 10 ? [lineup] : []),
        count: jest.fn().mockResolvedValue(1),
      },
      fantasyTimeIdentidade: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    db.$transaction = jest.fn(async (action: any) => action(db));
    service = new LineupService(db);
  });
  it('projects decimals, 12 stored contributions and captain inherited by a negative common reserve', async () => {
    const response = await service.get(10, 5);
    expect(response).toMatchObject({ id: 5, nomePublico: 'Time 01', formacao: '4-3-3', capitaoAtletaId: 1,
      resultado: { pontuacao: '34.41', revisao: '2', estadoPontuacao: 'PARCIAL', posicao: 1,
        capitaoOriginalAtletaId: 1, capitaoEfetivoAtletaId: 13, reservasUtilizados: [13], titularesSubstituidos: [1] } });
    const r = response.resultado!;
    expect(r.contribuicoes).toHaveLength(12);
    expect(r.atletas).toHaveLength(17);
    expect(r.atletas.find(a => a.catalogoAtletaId === 13)).toMatchObject({ pontuacaoOficial: '-0.2',
      pontuacaoContabilizada: '0', multiplicador: 2, capitaoEfetivo: true, reservaMagoDesignado: true,
      reservaUtilizado: true, utilizadoComoMago: false });
    expect(r.atletas.find(a => a.catalogoAtletaId === 1)).toMatchObject({ pontuacaoOficial: null,
      entrouEmCampo: false, origemParticipacao: 'NAO_PARTICIPACAO_INFERIDA_CARTOLA' });
    expect(r.substituicoes[0]).toMatchObject({ regra: 'COMUM', herdouCapitao: true });
    expect(JSON.stringify(response)).not.toMatch(/auditoria|hashFonte|usuarioId|private admin|evidenciaAusencias/);
    expect(db.fantasyPontuacaoAtleta.findMany).toHaveBeenCalledTimes(1);
  });
  it('omits absent results while preserving the original lineup fields', async () => {
    result = null;
    const response = await service.get(10, 5);
    expect(response).toMatchObject({ id: 5, formacao: '4-3-3', capitaoAtletaId: 1 });
    expect(response).not.toHaveProperty('resultado');
    expect(db.fantasyPontuacaoAtleta.findMany).not.toHaveBeenCalled();
  });
  it.each(['revisao', 'hashFonte', 'versaoEscalacao', 'versaoMotor', 'temporada', 'rodada', 'competicaoId'])('omits incompatible result: %s', async field => {
    result[field] = field === 'revisao' ? 3n : typeof result[field] === 'number' ? 99 : 'outdated';
    expect(await service.get(10, 5)).not.toHaveProperty('resultado');
  });
  it.each(['before', 'future', 'draft', 'private'])('blocks opponent detail: %s', async condition => {
    if (condition === 'before') c.fechamentoDefinitivoEm = null;
    if (condition === 'future') c.fechamentoDefinitivoEm = new Date('2099-01-01');
    if (condition === 'draft') lineup.status = 'RASCUNHO';
    if (condition === 'private') c.status = 'RASCUNHO';
    await expect(service.get(20, 5)).rejects.toMatchObject({ status: 404 });
    expect(db.fantasyEscalacaoResultado.findUnique).not.toHaveBeenCalled();
  });
  it('allows authenticated opponents only after closure and keeps owner access before closure', async () => {
    expect((await service.get(20, 5)).resultado?.pontuacao).toBe('34.41');
    c.fechamentoDefinitivoEm = null;
    expect((await service.get(10, 5)).id).toBe(5);
    expect((await service.get(10, 5)).resultado?.posicao).toBeNull();
  });
  it('batches summaries and preserves pagination with no official-point or audit reads', async () => {
    const response = await service.list(10, 1, { page: 2, limit: 3 });
    expect(response).toMatchObject({ page: 2, limit: 3, items: [{ id: 5, resultado: { pontuacao: '34.41' } }] });
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledTimes(2);
    expect(db.fantasyApuracaoRodada.findUnique).toHaveBeenCalledTimes(1);
    expect(db.fantasyEscalacaoResultado.findUnique).not.toHaveBeenCalled();
    expect(db.fantasyPontuacaoAtleta.findMany).not.toHaveBeenCalled();
  });
  it('fails closed on malformed audit without inventing contributions', async () => {
    result.auditoria.contributions[0].multiplier = '2';
    const context = await readResultSummaries(db, c);
    expect(await readResultDetail(db, c, lineup, context)).toBeUndefined();
  });
  it('does not infer official zero or participation without valid absence evidence', async () => {
    result.auditoria.evidenciaAusencias.sourceHash = 'old';
    const response = await service.get(10, 5);
    expect(response.resultado!.atletas.find(a => a.catalogoAtletaId === 1)).toMatchObject({
      pontuacaoOficial: null, entrouEmCampo: null, origemParticipacao: 'INFORMACAO_AUSENTE' });
  });
  it('distinguishes a persisted MAGO substitution from merely designating a Mago', async () => {
    result.auditoria.substitutions[0].kind = 'MAGO';
    const response = await service.get(10, 5);
    expect(response.resultado!.atletas.find(a => a.catalogoAtletaId === 13)).toMatchObject({
      reservaMagoDesignado: true, utilizadoComoMago: true });
    expect(response.resultado!.substituicoes[0].regra).toBe('MAGO');
  });
});
