import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';
import { completeSource } from './point-fantasy-source.fixture';

describe('3E administrative closure (mock transaction)', () => {
  let f: ReturnType<typeof completeSource>, db: any, c: any, actor: any, service: PointFantasyService, body: any;
  beforeEach(() => {
    f = completeSource();
    actor = { tipoUsuario: 'PLATFORM_ADMIN', status: 'ATIVO' };
    c = { id: 1, catalogoId: 3, temporada: 2026, rodada: 31, status: 'PUBLICADA',
      catalogo: { temporada: 2026, rodada: 31, status: 'CONGELADO' }, partidas: f.matches,
      fimInscricao: new Date(0), fechamentoDefinitivoEm: null, fechamentoAuditoria: null, atualizadoEm: new Date(0) };
    body = { temporada: 2026, rodada: 31, revisao: '2', hashFonte: f.round.hashConteudoAtual,
      operacaoId: 'af29da5e-e455-4d88-a266-4eef2adbd25a', motivo: 'Homologacao autorizada' };
    db = { $queryRaw: jest.fn(async () => []), usuario: { findUnique: jest.fn(async () => actor) },
      fantasyCompeticao: { findUniqueOrThrow: jest.fn(async () => c),
        updateMany: jest.fn(async ({ data }) => { Object.assign(c, data); return { count: 1 }; }) },
      fantasyApuracaoRodada: { findUniqueOrThrow: jest.fn(async () => f.round) },
      fantasyPontuacaoAtleta: { findMany: jest.fn(async () => f.points) },
      fantasyPontuacaoColeta: { findUnique: jest.fn(async () => f.collection), findMany: jest.fn(async () => { f.syncLegacy(); return [f.legacy]; }) },
      fantasyFechamentoAuditoria: { create: jest.fn(async ({ data }) => { c.fechamentoAuditoria = { dados: data.dados }; return data; }) },
    };
    db.$transaction = jest.fn(async action => {
      const before = { ...c };
      try { return await action(db); } catch (e) { c = before; throw e; }
    });
    service = new PointFantasyService(db, {} as any);
  });
  it('closes once with immutable audit and idempotent retry', async () => {
    const first = await service.closeCompetition(1, 7, body);
    expect(first.fechamentoDefinitivoEm).toBeInstanceOf(Date);
    expect(await service.closeCompetition(1, 7, body)).toEqual(first);
    expect(db.fantasyCompeticao.updateMany).toHaveBeenCalledTimes(1);
    expect(db.fantasyFechamentoAuditoria.create).toHaveBeenCalledTimes(1);
    expect(c.fechamentoAuditoria.dados).toMatchObject({ usuarioId: 7, revisao: '2', hashFonte: body.hashFonte });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
  it.each(['player', 'inactive', 'season', 'revision', 'hash', 'incomplete', 'in-progress', 'window', 'no-games'])('rejects unsafe closure: %s', async reason => {
    if (reason === 'player') actor.tipoUsuario = 'PLAYER';
    if (reason === 'inactive') actor.status = 'INATIVO';
    if (reason === 'season') body.temporada = 2025;
    if (reason === 'revision') body.revisao = '3';
    if (reason === 'hash') body.hashFonte = 'a'.repeat(64);
    if (reason === 'incomplete') f.legacyPayload.total_atletas++;
    if (reason === 'in-progress') f.legacyMatches.partidas[0].periodo_tr = 'PRIMEIRO_TEMPO';
    if (reason === 'window') c.fimInscricao = new Date(Date.now() + 100000);
    if (reason === 'no-games') c.partidas = [];
    await expect(service.closeCompetition(1, 7, body)).rejects.toThrow();
    expect(db.fantasyCompeticao.updateMany).not.toHaveBeenCalled();
    expect(db.fantasyFechamentoAuditoria.create).not.toHaveBeenCalled();
  });
  it('rejects conflicting closure replay instead of changing the original audit', async () => {
    await service.closeCompetition(1, 7, body);
    await expect(service.closeCompetition(1, 7, { ...body, motivo: 'Changed reason' })).rejects.toThrow('outra operacao');
    expect(db.fantasyCompeticao.updateMany).toHaveBeenCalledTimes(1);
  });
  it('rolls audit back when closure compare-and-set fails', async () => {
    db.fantasyCompeticao.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.closeCompetition(1, 7, body)).rejects.toThrow('alterada');
    expect(c.fechamentoDefinitivoEm).toBeNull(); expect(c.fechamentoAuditoria).toBeNull();
  });
});
