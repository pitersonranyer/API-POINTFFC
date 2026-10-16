import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Prisma } from '@prisma/client';
import * as teamIdentity from '../src/point-fantasy/lineups/team-identity';
import { PrismaService } from '../src/prisma/prisma.service';
import { LineupService } from '../src/point-fantasy/lineups/lineup.service';
import { CreateLineupDto, DuplicateLineupDto, UpdateLineupDto } from '../src/point-fantasy/lineups/lineup.dto';
import { normalizeTeamName } from '../src/point-fantasy/lineups/team-identity';

describe('Public team identity', () => {
  let service: LineupService, tx: any, identities: any[], lineups: any[], operations: any[];
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    identities = []; lineups = []; operations = [];
    const match = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
    tx = {
      usuario: { findUnique: jest.fn(async () => ({ status: 'ATIVO' })) },
      fantasyCompeticao: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, status: 'PUBLICADA',
        temporada: 2026, rodada: 1, catalogoId: 1, catalogo: { temporada: 2026, rodada: 1, status: 'CONGELADO' },
        inicioInscricao: new Date(0), fechamentoDefinitivoEm: null,
        partidas: [{ status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date('2099-01-01'), clubeMandanteId: 1, clubeVisitanteId: 2 }] })) },
      fantasyTimeIdentidade: {
        findUnique: jest.fn(async ({ where }: any) => identities.find(i => match(i, where.usuarioId_competicaoId)) ?? null),
        create: jest.fn(async ({ data }: any) => { const i = { id: identities.length + 1, ultimoSequencial: 0, ...data }; identities.push(i); return { ...i }; }),
        update: jest.fn(async ({ where }: any) => { const i = identities.find(i => i.id === where.id); i.ultimoSequencial++; return { ...i }; }),
      },
      fantasyTimeOperacao: {
        findUnique: jest.fn(async ({ where }: any) => operations.find(o => match(o, where.identidadeId_chave)) ?? null),
        create: jest.fn(async ({ data }: any) => { operations.push(data); return data; }),
      },
      fantasyEscalacao: {
        create: jest.fn(async ({ data }: any) => { const row = { id: lineups.length + 1, versao: 1, ...data, atletas: [], identidade: { ...identities.find(i => i.id === data.identidadeId) } }; lineups.push(row); return row; }),
        findFirst: jest.fn(async ({ where }: any) => lineups.find(l => match(l, where)) ?? null),
        findMany: jest.fn(async ({ where }: any) => lineups.filter(l => match(l, where))),
        count: jest.fn(async ({ where }: any) => lineups.filter(l => match(l, where)).length),
        deleteMany: jest.fn(async ({ where }: any) => { const found = lineups.find(l => match(l, where)); lineups = lineups.filter(l => l !== found); return { count: found ? 1 : 0 }; }),
      },
    };
    // A rollback-capable fake verifies service transaction boundaries; actual SQL races live in integration tests.
    service = new LineupService({ $transaction: async (action: any) => {
      const snapshot = JSON.parse(JSON.stringify({ identities, operations })); const rows = [...lineups];
      try { return await action(tx); } catch (e) { identities = snapshot.identities; operations = snapshot.operations; lineups = rows; throw e; }
    } } as unknown as PrismaService);
  });
  it.each([undefined, 'Meu Time', 'Tropa do Mago'])('first save persists name %s and sequence 01', async nomeBase => {
    const result = await service.create(1, 10, { formacao: '4-3-3', nomeBase });
    expect(result.identidade?.nomeBase).toBe(nomeBase ?? 'Meu Time');
    expect(result.sequencial).toBe(1); expect(result.nomePublico).toMatch(/^#[A-HJ-NP-Z2-9]{7} · .+ 01$/);
    expect(result.legado).toBe(false);
  });
  it('inherits names on second, third and duplicate; never reuses deleted sequences', async () => {
    const a = await service.create(1, 10, { formacao: '4-3-3', nomeBase: 'Mago' });
    expect((await service.create(1, 10, { formacao: '4-3-3' })).sequencial).toBe(2);
    expect((await service.create(1, 10, { formacao: '4-3-3' })).sequencial).toBe(3);
    expect((await service.duplicate(1, a.id, 1)).sequencial).toBe(4);
    for (const row of [...lineups]) await service.remove(1, row.id, 1);
    const list = await service.list(1, 10, { page: 1, limit: 50 });
    expect(list).toMatchObject({ estadoIdentidade: 'DEFINIDA', total: 0, identidade: { nomeBase: 'Mago', ultimoSequencial: 4 } });
    const next = await service.create(1, 10, { formacao: '4-3-3' });
    expect(next.sequencial).toBe(5);
    expect(next.identidade?.identificadorPublico).toBe(a.identidade?.identificadorPublico);
  });
  it('rejects renaming without incrementing counter', async () => {
    await service.create(1, 10, { formacao: '4-3-3', nomeBase: 'Mago' });
    await expect(service.create(1, 10, { formacao: '4-3-3', nomeBase: 'Outro' })).rejects.toMatchObject({ status: 409 });
    expect(identities[0].ultimoSequencial).toBe(1);
  });
  it('replays create and duplicate keys; rejects changed payload and deleted replay', async () => {
    const dto = { formacao: '4-3-3', chaveIdempotencia: 'create-1' };
    const a = await service.create(1, 10, dto);
    expect((await service.create(1, 10, dto)).id).toBe(a.id);
    const b = await service.duplicate(1, a.id, 1, { chaveIdempotencia: 'copy-1' });
    expect((await service.duplicate(1, a.id, 1, { chaveIdempotencia: 'copy-1' })).id).toBe(b.id);
    await expect(service.create(1, 10, { ...dto, formacao: '4-4-2' })).rejects.toMatchObject({ status: 409 });
    await service.remove(1, a.id, 1);
    await expect(service.create(1, 10, dto)).rejects.toMatchObject({ status: 409 });
    expect(identities[0].ultimoSequencial).toBe(2);
  });
  it('rolls back identity and counter if draft or operation persistence fails', async () => {
    tx.fantasyEscalacao.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(service.create(1, 10, { formacao: '4-3-3' })).rejects.toThrow('write failed');
    expect(identities).toHaveLength(0);
    tx.fantasyTimeOperacao.create.mockRejectedValueOnce(new Error('ledger failed'));
    await expect(service.create(1, 10, { formacao: '4-3-3', chaveIdempotencia: 'a' })).rejects.toThrow('ledger failed');
    expect(identities).toHaveLength(0); expect(lineups).toHaveLength(0);
  });
  it('isolates owners and competitions', async () => {
    const a = await service.create(1, 10, { formacao: '4-3-3', nomeBase: 'Um' });
    const b = await service.create(2, 10, { formacao: '4-3-3', nomeBase: 'Dois' });
    const c = await service.create(1, 11, { formacao: '4-3-3', nomeBase: 'Tres' });
    expect([a.sequencial, b.sequencial, c.sequencial]).toEqual([1, 1, 1]);
    expect(new Set([a.nomePublico, b.nomePublico, c.nomePublico]).size).toBe(3);
    await expect(service.get(2, a.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.list(3, 10, { page: 1, limit: 50 })).estadoIdentidade).toBe('NOVO');
  });
  it('leaves legacy drafts untouched when assigning new identity', async () => {
    lineups.push({ id: 90, usuarioId: 1, competicaoId: 10, identidadeId: null, nomePublico: null, sequencial: null,
      status: 'RASCUNHO', versao: 1, formacao: '4-3-3', atletas: [], capitaoAtletaId: null, reservaMagoAtletaId: null });
    expect((await service.list(1, 10, { page: 1, limit: 50 })).estadoIdentidade).toBe('LEGADO');
    const copy = await service.duplicate(1, 90, 1, { nomeBase: 'Novo' });
    expect(copy.sequencial).toBe(1);
    expect(await service.get(1, 90)).toMatchObject({ legado: true, nomePublico: null, sequencial: null });
    expect((await service.list(1, 10, { page: 1, limit: 50 })).rascunhosLegados).toBe(1);
  });
  it('retries only public-code collisions with fresh transactions and the original name', async () => {
    const generate = jest.spyOn(teamIdentity, 'generatePublicTeamCode').mockReturnValueOnce('AAAAAAA').mockReturnValue('BBBBBBB');
    tx.fantasyTimeIdentidade.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('collision', {
      code: 'P2002', clientVersion: '5.22.0', meta: { target: 'FANTASY_TIME_IDENTIDADE_IDENTIFICADOR_PUBLICO_key' },
    }));
    const result = await service.create(1, 10, { formacao: '4-3-3', nomeBase: 'Escolhido', chaveIdempotencia: 'first' });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ sequencial: 1, identidade: { identificadorPublico: 'BBBBBBB', nomeBase: 'Escolhido' } });
    expect(identities).toHaveLength(1); expect(lineups).toHaveLength(1); expect(operations).toHaveLength(1);
  });
  it('exhausts five public-code collision attempts with controlled 409 and no writes', async () => {
    const generate = jest.spyOn(teamIdentity, 'generatePublicTeamCode').mockReturnValue('AAAAAAA');
    tx.fantasyTimeIdentidade.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('collision', {
      code: 'P2002', clientVersion: '5.22.0', meta: { target: ['IDENTIFICADOR_PUBLICO'] },
    }));
    await expect(service.create(1, 10, { formacao: '4-3-3', nomeBase: 'Escolhido' })).rejects.toMatchObject({ status: 409 });
    expect(generate).toHaveBeenCalledTimes(5);
    expect(identities).toHaveLength(0); expect(lineups).toHaveLength(0); expect(operations).toHaveLength(0);
  });
  it.each(['FTI_USUARIO_COMP_key', 'unknown_index'])('does not retry another unique conflict: %s', async target => {
    tx.fantasyTimeIdentidade.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('collision', {
      code: 'P2002', clientVersion: '5.22.0', meta: { target },
    }));
    await expect(service.create(1, 10, { formacao: '4-3-3' })).rejects.toMatchObject({ status: 409 });
    expect(tx.fantasyTimeIdentidade.create).toHaveBeenCalledTimes(1);
  });
  it('public-name collision returns 409 and rolls back without retrying or renaming', async () => {
    tx.fantasyEscalacao.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('name collision', {
      code: 'P2002', clientVersion: '5.22.0', meta: { target: 'FE_COMP_NOME_key' },
    }));
    await expect(service.create(1, 10, { formacao: '4-3-3', nomeBase: 'Solicitado' })).rejects.toMatchObject({ status: 409 });
    expect(tx.fantasyTimeIdentidade.create).toHaveBeenCalledTimes(1);
    expect(tx.fantasyTimeIdentidade.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nomeBase: 'Solicitado' }) }));
    expect(identities).toHaveLength(0); expect(lineups).toHaveLength(0);
  });
  it('never replaces an already assigned long identifier', async () => {
    await service.create(1, 10, { formacao: '4-3-3' });
    identities[0].identificadorPublico = 'a'.repeat(32);
    const generate = jest.spyOn(teamIdentity, 'generatePublicTeamCode');
    const result = await service.create(1, 10, { formacao: '4-3-3' });
    expect(result.identidade?.identificadorPublico).toBe('a'.repeat(32));
    expect(result.nomePublico).toContain('#' + 'a'.repeat(32));
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('Short public code generation', () => {
  it('uses seven uppercase unambiguous characters', () => {
    expect(teamIdentity.PUBLIC_TEAM_CODE_ALPHABET).toHaveLength(32);
    for (let i = 0; i < 100; i++) expect(teamIdentity.generatePublicTeamCode()).toMatch(/^[A-HJ-NP-Z2-9]{7}$/);
  });
});

describe('Identity input validation', () => {
  it('normalizes NFC and spaces', () => expect(normalizeTeamName('  Cafe\u0301   FC ')).toBe('Café FC'));
  it.each(['', 'A', 'a'.repeat(61), '<script>', 'A\nB', 'A\tB', 'A\u200bB', null, 42])('rejects invalid name %s', name => {
    expect(() => normalizeTeamName(name)).toThrow();
  });
  it.each([CreateLineupDto, DuplicateLineupDto, UpdateLineupDto])('rejects client identity fields: %p', async dto => {
    const errors = await validate(plainToInstance(dto as any, { formacao: '4-3-3', versao: 1,
      nomePublico: 'forged', sequencial: 5, identificadorPublico: 'forged' }) as object,
    { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map(e => e.property)).toEqual(expect.arrayContaining(['nomePublico', 'sequencial', 'identificadorPublico']));
  });
});
