import { Prisma } from '@prisma/client';
import { LineupService } from '../src/point-fantasy/lineups/lineup.service';
import { completeLineup } from './point-fantasy-lineup.fixture';

describe('FREE registration transaction', () => {
  let db: any, service: LineupService, c: any, rows: any[], operations: any[], userStatus: string;
  let failOn: number | undefined;
  const { selection, athletes } = completeLineup();
  const dto = (ids = [1], chaveIdempotencia = 'confirm-1') => ({ escalacaoIds: ids, chaveIdempotencia });
  beforeEach(() => {
    userStatus = 'ATIVO'; failOn = undefined; operations = [];
    c = { id: 8, nome: 'FREE', catalogoId: 3, temporada: 2026, rodada: 31,
      catalogo: { status: 'CONGELADO', temporada: 2026, rodada: 31 }, status: 'PUBLICADA', tipoAcesso: 'FREE',
      valorInscricao: new Prisma.Decimal(0), inicioInscricao: new Date(Date.now() - 60000),
      fimInscricao: new Date(Date.now() + 60000), fechamentoDefinitivoEm: null, limiteEscalacoesUsuario: 3,
      partidas: [{ clubeMandanteId: 263, clubeVisitanteId: 264, status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date(Date.now() + 120000) }] };
    rows = [1, 2, 3].map(id => ({ id, usuarioId: 7, competicaoId: 8, status: 'RASCUNHO', versao: 1,
      nomePublico: `#ABC2345 · Time ${id}`, sequencial: id, identidadeId: 1, identidade: { nomeBase: 'Time', identificadorPublico: 'ABC2345', ultimoSequencial: 3 },
      formacao: selection.formacao, capitaoAtletaId: selection.capitaoAtletaId, reservaMagoAtletaId: selection.reservaMagoAtletaId,
      atletas: athletes.map(a => ({ catalogoAtletaId: a.id, atleta: a,
        papel: selection.titulares.includes(a.id) ? 'TITULAR' : selection.tecnico === a.id ? 'TECNICO' : 'RESERVA' })) }));
    db = {
      fantasyApuracaoRodada: { findUnique: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn(), usuario: { findUnique: jest.fn(async () => ({ status: userStatus })) },
      fantasyCompeticao: { findUnique: jest.fn(async () => c) },
      fantasyCatalogoAtleta: { findMany: jest.fn(async () => athletes) },
      fantasyEscalacaoAtleta: {
        deleteMany: jest.fn(async ({ where }: any) => { rows.find(r => r.id === where.escalacaoId).atletas = []; }),
        createMany: jest.fn(async ({ data }: any) => {
          for (const row of data) rows.find(r => r.id === row.escalacaoId).atletas.push({ ...row, atleta: athletes.find(a => a.id === row.catalogoAtletaId) });
        }),
      },
      fantasyInscricaoOperacao: {
        findUnique: jest.fn(async ({ where }: any) => operations.find(o => o.chave === where.usuarioId_competicaoId_chave.chave) ?? null),
        create: jest.fn(async ({ data }: any) => { const op = { id: operations.length + 1, ...data }; operations.push(op); return op; }),
      },
      fantasyEscalacao: {
        findMany: jest.fn(async ({ where }: any) => rows.filter(r => where.id.in.includes(r.id) && r.usuarioId === where.usuarioId && r.competicaoId === where.competicaoId)),
        findFirst: jest.fn(async ({ where }: any) => rows.find(r => r.id === where.id && r.usuarioId === where.usuarioId)),
        count: jest.fn(async () => rows.filter(r => r.status === 'INSCRITA').length),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.id === failOn) throw new Error('Persistence failed');
          const r = rows.find(r => r.id === where.id && r.status === where.status && r.versao === where.versao);
          if (!r) return { count: 0 };
          Object.assign(r, data, { versao: r.versao + 1 }); return { count: 1 };
        }),
      },
    };
    db.$transaction = jest.fn(async (action: any) => {
      const savedRows = rows.map(r => ({ ...r, atletas: [...r.atletas] })); const savedOps = [...operations];
      try { return await action(db); } catch (error) { rows = savedRows; operations = savedOps; throw error; }
    });
    service = new LineupService(db);
  });
  const confirm = (ids?: number[], key?: string) => service.confirmFree(7, 8, dto(ids, key));
  it.each([[1], [1, 2]])('confirms selected existing drafts: %j', async (...ids) => {
    const selected = ids as number[];
    const result = await confirm(selected) as any;
    expect(result).toMatchObject({ quantidadeConfirmada: selected.length, valorTotal: '0.00', estado: 'CONFIRMADA' });
    expect(rows.filter(r => r.status === 'INSCRITA')).toHaveLength(selected.length);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ nomePublico: '#ABC2345 · Time 1', sequencial: 1, identidadeId: 1 });
    expect(operations).toHaveLength(1);
    // The fake exposes only Fantasy and user reads: any financial access fails this test.
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
  it('rejects inactive user', async () => { userStatus = 'INATIVO'; await expect(confirm()).rejects.toThrow('ativo'); });
  it('rejects missing competition', async () => { c = null; await expect(confirm()).rejects.toThrow('nao encontrada'); });
  it.each(['PAGO', 'RASCUNHO', 'early', 'late', 'closed', 'started', 'scheduled', 'cancelled'])('rejects unavailable competition: %s', async reason => {
    if (reason === 'PAGO') c.tipoAcesso = 'PAGO';
    if (reason === 'RASCUNHO') c.status = 'RASCUNHO';
    if (reason === 'early') c.inicioInscricao = new Date(Date.now() + 60000);
    if (reason === 'late') c.fimInscricao = new Date(Date.now() - 1);
    if (reason === 'closed') c.fechamentoDefinitivoEm = new Date(Date.now() - 1);
    if (reason === 'started') c.partidas[0].inicioReal = new Date();
    if (reason === 'scheduled') c.partidas[0].inicioPrevisto = new Date(Date.now() - 1);
    if (reason === 'cancelled') c.partidas[0].status = 'CANCELADA';
    await expect(confirm()).rejects.toThrow(); expect(operations).toHaveLength(0);
  });
  it.each(['owner', 'competition', 'incomplete', 'ineligible'])('rejects invalid lineup: %s', async reason => {
    if (reason === 'owner') rows[0].usuarioId = 99;
    if (reason === 'competition') rows[0].competicaoId = 99;
    if (reason === 'incomplete') rows[0].atletas = [];
    if (reason === 'ineligible') db.fantasyCatalogoAtleta.findMany.mockResolvedValue([]);
    await expect(confirm()).rejects.toThrow(); expect(operations).toHaveLength(0);
  });
  it('counts confirmed teams, rejects already registered teams and preserves drafts on failure', async () => {
    c.limiteEscalacoesUsuario = 1; await confirm();
    await expect(confirm([2], 'second')).rejects.toThrow('Limite');
    await expect(confirm([1], 'again')).rejects.toThrow('indisponivel');
    expect(rows[1].status).toBe('RASCUNHO');
  });
  it('replays the same set in any order even after deadline; rejects different content', async () => {
    const result = await confirm([1, 2]); c.fimInscricao = new Date(0);
    expect(await confirm([2, 1])).toEqual(result);
    await expect(confirm([3])).rejects.toThrow('parametros diferentes');
    expect(operations).toHaveLength(1);
  });
  it('rolls back every registration and operation after a partial persistence failure', async () => {
    failOn = 2; await expect(confirm([1, 2])).rejects.toThrow('Persistence failed');
    expect(rows.every(r => r.status === 'RASCUNHO')).toBe(true); expect(operations).toHaveLength(0);
  });
  it('rechecks deadline after persistence and rolls back the batch', async () => {
    db.fantasyInscricaoOperacao.create.mockImplementation(async () => { c.fimInscricao = new Date(0); return { id: 1 }; });
    await expect(confirm()).rejects.toThrow('encerrado'); expect(rows[0].status).toBe('RASCUNHO');
  });
  it('allows FREE update but blocks duplication, deletion and registration again', async () => {
    await confirm();
    const original = { ...rows[0] }, operation = { ...operations[0] };
    const saved = await service.update(7, 1, { versao: 2, capitaoAtletaId: selection.titulares[1] });
    expect(saved).toMatchObject({ id: 1, versao: 3, status: 'INSCRITA', confirmadaEm: original.confirmadaEm,
      nomePublico: original.nomePublico, identidade: original.identidade, capitaoAtletaId: selection.titulares[1] });
    expect(rows[0].inscricaoOperacaoId).toBe(original.inscricaoOperacaoId);
    expect(operations).toEqual([operation]);
    await expect(service.remove(7, 1, 3)).rejects.toThrow('indisponivel');
    await expect(service.duplicate(7, 1, 3)).rejects.toThrow('indisponivel');
    await expect(confirm([1], 'again')).rejects.toThrow('indisponivel');
    expect(await service.get(7, 1)).toMatchObject({ status: 'INSCRITA', confirmadaEm: expect.any(Date) });
  });
  it.each(['incomplete', 'invalid', 'owner', 'inactive', 'paid', 'stale', 'status', 'catalog', 'late', 'closed', 'scheduled', 'started'])('rejects registered edit without any mutation: %s', async reason => {
    await confirm();
    const before = { ...rows[0], atletas: [...rows[0].atletas] };
    const patch: any = { versao: 2 };
    if (reason === 'incomplete') patch.tecnico = null;
    if (reason === 'invalid') patch.capitaoAtletaId = 999;
    if (reason === 'inactive') userStatus = 'INATIVO';
    if (reason === 'paid') c.tipoAcesso = 'PAGO';
    if (reason === 'stale') patch.versao = 1;
    if (reason === 'status') c.status = 'ENCERRADA';
    if (reason === 'catalog') c.catalogo.status = 'RASCUNHO';
    if (reason === 'late') c.fimInscricao = new Date(0);
    if (reason === 'closed') c.fechamentoDefinitivoEm = new Date(0);
    if (reason === 'scheduled') c.partidas[0].inicioPrevisto = new Date(0);
    if (reason === 'started') c.partidas[0].inicioReal = new Date();
    await expect(service.update(reason === 'owner' ? 99 : 7, 1, patch)).rejects.toThrow();
    expect(rows[0]).toEqual(before);
  });
  it.each(['fimInscricao', 'fechamentoDefinitivoEm', 'inicioPrevisto'])('rejects exactly at %s', async field => {
    await confirm();
    jest.useFakeTimers().setSystemTime(new Date());
    try {
      if (field === 'inicioPrevisto') c.partidas[0][field] = new Date();
      else c[field] = new Date();
      await expect(service.update(7, 1, { versao: 2 })).rejects.toMatchObject({ status: 409 });
      expect(rows[0].versao).toBe(2);
    } finally { jest.useRealTimers(); }
  });
  it.each(['deadline', 'administrative', 'persistence'])('rolls back all edited fields after %s failure', async reason => {
    await confirm();
    const before = { ...rows[0], atletas: [...rows[0].atletas] };
    const persist = db.fantasyEscalacaoAtleta.createMany.getMockImplementation();
    db.fantasyEscalacaoAtleta.createMany.mockImplementation(async (args: any) => {
      if (reason === 'persistence') throw new Error('Persistence failed');
      await persist(args);
      if (reason === 'deadline') c.fimInscricao = new Date(0);
      else c = { ...c, status: 'ENCERRADA' };
    });
    await expect(service.update(7, 1, { versao: 2, capitaoAtletaId: selection.titulares[1] })).rejects.toThrow();
    expect(rows[0]).toEqual(before);
    expect(operations).toHaveLength(1);
  });
  it('rolls back when the clock reaches the deadline during persistence', async () => {
    await confirm();
    const before = { ...rows[0], atletas: [...rows[0].atletas] };
    const persist = db.fantasyEscalacaoAtleta.createMany.getMockImplementation();
    jest.useFakeTimers().setSystemTime(new Date());
    try {
      db.fantasyEscalacaoAtleta.createMany.mockImplementation(async (args: any) => {
        await persist(args);
        jest.setSystemTime(c.fimInscricao);
      });
      await expect(service.update(7, 1, { versao: 2, capitaoAtletaId: selection.titulares[1] })).rejects.toMatchObject({ status: 409 });
      expect(rows[0]).toEqual(before);
    } finally { jest.useRealTimers(); }
  });
  it('returns 409 when conditional update loses a race with another edit or confirmation', async () => {
    await confirm();
    db.fantasyEscalacao.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.update(7, 1, { versao: 2 })).rejects.toMatchObject({ status: 409 });
    expect(db.fantasyEscalacaoAtleta.deleteMany).not.toHaveBeenCalled();
  });
  it('translates serialization conflict into retryable 409', async () => {
    db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '5.22.0' }));
    await expect(confirm()).rejects.toMatchObject({ status: 409 });
  });
});
