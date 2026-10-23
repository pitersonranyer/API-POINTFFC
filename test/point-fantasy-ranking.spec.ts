import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { OptionalJwtAuthGuard } from '../src/auth/optional-jwt-auth.guard';
import { PointFantasyController } from '../src/point-fantasy/point-fantasy.controller';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';

describe('POINT Fantasy public registered teams ranking', () => {
  let app: INestApplication, url: string, db: any, competition: any, rows: any[];
  beforeAll(async () => {
    db = {
      fantasyCompeticao: { findFirst: jest.fn(async ({ where }: any) =>
        competition?.id === where.id && competition.status === where.status ? competition : null) },
      fantasyEscalacao: {
        findMany: jest.fn(async ({ where, skip, take, select }: any) => rows
          .filter(r => r.competicaoId === where.competicaoId && r.status === where.status)
          .sort((a, b) => a.id - b.id).slice(skip, skip + take)
          .map(r => Object.fromEntries(Object.keys(select).map(key => [key, r[key]])))),
        count: jest.fn(async ({ where }: any) => rows.filter(r => r.competicaoId === where.competicaoId && r.status === where.status).length),
      },
    };
    db.$transaction = jest.fn(async (action: any) => action(db));
    const module = await Test.createTestingModule({ controllers: [PointFantasyController], providers: [
      OptionalJwtAuthGuard,
      { provide: PointFantasyService, useValue: new PointFantasyService(db, {} as any) },
      { provide: AuthService, useValue: { authenticateJwt: async (token: string) => {
        if (!['owner', 'other', 'blocked'].includes(token)) throw new UnauthorizedException();
        return { idUsuario: token === 'owner' ? 7 : 9, status: token === 'blocked' ? 'BLOQUEADO' : 'ATIVO' };
      } } },
    ] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    jest.clearAllMocks();
    competition = { id: 8, status: 'PUBLICADA', tipoAcesso: 'FREE', partidas: [
      { status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date(Date.now() + 3600000) },
    ] };
    rows = [4, 1, 3, 2, 5].map(id => ({ id, competicaoId: id === 5 ? 99 : 8,
      status: id === 3 ? 'RASCUNHO' : 'INSCRITA', usuarioId: id === 4 ? 9 : 7,
      nomePublico: id === 2 ? null : `Time ${id}`, sequencial: id === 2 ? null : id,
      identidade: id === 2 ? null : { identificadorPublico: 'ABC2345', nomeBase: 'Time' },
      formacao: '4-3-3', email: 'private@test.invalid', telefone: 'private', nome: 'Private Name',
    }));
  });
  const request = (query = '', token?: string, id = 8) => fetch(`${url}/point-fantasy/competicoes/${id}/ranking${query}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it('lists every enrolled team across owners, including multiple teams and nullable legacy identity', async () => {
    const res = await request(); const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toMatchObject({ competicaoId: 8, total: 3, page: 1, limit: 50, estadoPontuacao: 'NAO_INICIADA' });
    expect(body.items.map((r: any) => r.escalacaoId)).toEqual([1, 2, 4]);
    expect(body.items[0].identidade).toEqual({ identificadorPublico: 'ABC2345', nomeBase: 'Time', sequencial: 1 });
    expect(body.items[1]).toMatchObject({ identidade: null, nomePublico: null });
    for (const item of body.items) {
      expect(item).toMatchObject({ posicao: null, pontuacao: null, meuTime: false, formacao: null });
      expect(Object.keys(item).sort()).toEqual(['posicao', 'pontuacao', 'meuTime', 'formacao', 'identidade', 'nomePublico', 'escalacaoId'].sort());
    }
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledTimes(1);
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledWith({ where: { competicaoId: 8, status: 'INSCRITA' },
      orderBy: { id: 'asc' }, skip: 0, take: 50,
      select: { id: true, usuarioId: true, nomePublico: true, sequencial: true, formacao: true,
        identidade: { select: { identificadorPublico: true, nomeBase: true } } } });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });
  it.each([['owner', [true, true, false]], ['other', [false, false, true]]])('marks ownership using only validated JWT: %s', async (token, expected) => {
    const res = await request('', token as string); const body = await res.json() as any;
    expect(body.items.map((r: any) => r.meuTime)).toEqual(expected);
    expect(body.items.map((r: any) => r.formacao)).toEqual((expected as boolean[]).map(own => own ? '4-3-3' : null));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(JSON.stringify(body)).not.toMatch(/usuarioId|email|telefone|Private Name/);
  });
  it.each(['invalid', 'blocked'])('rejects invalid or blocked credentials: %s', async token => {
    expect((await request('', token)).status).toBe(token === 'blocked' ? 403 : 401);
    expect(db.fantasyEscalacao.findMany).not.toHaveBeenCalled();
  });
  it('paginates in the database and counts teams rather than owners', async () => {
    const body = await (await request('?page=2&limit=2')).json() as any;
    expect(body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(body.items.map((r: any) => r.escalacaoId)).toEqual([4]);
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 2 }));
    expect((await (await request('?page=5&limit=2')).json() as any).items).toEqual([]);
  });
  it.each(['?page=0', '?page=-1', '?page=1.5', '?page=abc', '?page=1000001', '?limit=0', '?limit=101', '?limit=1.5', '?usuarioId=7'])('rejects invalid or forged query: %s', async query => {
    expect((await request(query)).status).toBe(400);
    expect(db.fantasyEscalacao.findMany).not.toHaveBeenCalled();
  });
  it.each([0, -1, 4294967296])('validates competition ID %s', async id => {
    expect((await request('', undefined, id)).status).toBe(400);
  });
  it.each(['missing', 'RASCUNHO', 'ENCERRADA', 'CANCELADA', 'PRIVADA'])('preserves restrictive public visibility: %s', async status => {
    if (status === 'missing') competition = null; else competition.status = status;
    expect((await request()).status).toBe(404);
    expect(db.fantasyEscalacao.findMany).not.toHaveBeenCalled();
  });
  it.each(['scheduled-now', 'scheduled-past', 'real', 'status', 'empty', 'invalid-date', 'another-match'])('reports unavailable scoring conservatively: %s', async reason => {
    if (reason === 'scheduled-now') competition.partidas[0].inicioPrevisto = new Date();
    if (reason === 'scheduled-past') competition.partidas[0].inicioPrevisto = new Date(0);
    if (reason === 'real') competition.partidas[0].inicioReal = new Date();
    if (reason === 'status') competition.partidas[0].status = 'EM_ANDAMENTO';
    if (reason === 'empty') competition.partidas = [];
    if (reason === 'invalid-date') competition.partidas[0].inicioPrevisto = new Date(NaN);
    if (reason === 'another-match') competition.partidas.push({ ...competition.partidas[0], inicioPrevisto: new Date(0) });
    const body = await (await request()).json() as any;
    expect(body.estadoPontuacao).toBe('INDISPONIVEL');
    expect(body.items.every((r: any) => r.posicao === null && r.pontuacao === null)).toBe(true);
  });
  it('supports empty competitions and PAGO reads without financial access', async () => {
    competition.tipoAcesso = 'PAGO'; rows = [];
    expect(await (await request()).json()).toMatchObject({ items: [], total: 0 });
  });
});
