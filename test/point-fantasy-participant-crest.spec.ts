import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { CREST_CATALOG, CREST_IDS, participantCrest } from '../src/point-fantasy/participant-crest';
import { ParticipantCrestController, UpdateParticipantCrestDto } from '../src/point-fantasy/participant-crest.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { Test } from '@nestjs/testing';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';

describe('Participant Fantasy crest', () => {
  const user = { idUsuario: 7 } as any;
  let controller: ParticipantCrestController;
  let preferences: Map<number, string>;
  let db: any;
  beforeEach(() => {
    preferences = new Map();
    db = { usuario: {
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({ fantasyBrasaoId: preferences.get(where.idUsuario) ?? null })),
      update: jest.fn(async ({ where, data }: any) => { preferences.set(where.idUsuario, data.fantasyBrasaoId); return { idUsuario: where.idUsuario }; }),
    } };
    controller = new ParticipantCrestController(db as PrismaService);
  });
  it('provides twelve immutable versioned render recipes matching the old SVG', () => {
    expect(new Set(CREST_IDS).size).toBe(12);
    expect(controller.catalog()).toEqual({ versao: 'v1', items: CREST_CATALOG });
    expect(new Set(CREST_CATALOG.map(c => c.color)).size).toBe(4);
    expect(new Set(CREST_CATALOG.map(c => c.variant))).toEqual(new Set([0, 1, 2]));
  });
  it('returns deterministic fallback without persisting a preference', async () => {
    expect(await controller.get(user)).toEqual({ brasaoId: participantCrest(7), escolhido: false });
    expect(await controller.get(user)).toEqual(await controller.get(user));
    expect(CREST_IDS).toContain(participantCrest(7));
    expect(db.usuario.update).not.toHaveBeenCalled();
  });
  it('persists choice across controller sessions and supports replacement', async () => {
    await controller.update(user, { brasaoId: CREST_IDS[0] });
    const session = new ParticipantCrestController(db);
    expect(await session.get(user)).toEqual({ brasaoId: CREST_IDS[0], escolhido: true });
    await session.update(user, { brasaoId: CREST_IDS[11] });
    expect(await controller.get(user)).toEqual({ brasaoId: CREST_IDS[11], escolhido: true });
  });
  it.each([null, undefined, '', 'v2:c0:p0', 'v1:c4:p0', '<svg/>', 1])('rejects invalid choice %s without writes', async brasaoId => {
    expect((await validate(plainToInstance(UpdateParticipantCrestDto, { brasaoId }))).length).toBeGreaterThan(0);
    await expect(controller.update(user, { brasaoId } as any)).rejects.toMatchObject({ status: 400 });
    expect(db.usuario.update).not.toHaveBeenCalled();
  });
  it('accepts every catalog ID through DTO validation', async () => {
    for (const brasaoId of CREST_IDS) expect(await validate(plainToInstance(UpdateParticipantCrestDto, { brasaoId }))).toEqual([]);
  });
  it('uses authenticated owner even if body supplies another user', async () => {
    await controller.update(user, { brasaoId: CREST_IDS[2], usuarioId: 8 } as any);
    expect(await controller.get({ idUsuario: 8 } as any)).toMatchObject({ escolhido: false });
    expect(preferences.has(8)).toBe(false);
    expect(Reflect.getMetadata(GUARDS_METADATA, ParticipantCrestController)).toEqual([JwtAuthGuard]);
  });
  it('enforces JWT, blocked-user guard, body validation and owner isolation over HTTP', async () => {
    const module = await Test.createTestingModule({ controllers: [ParticipantCrestController], providers: [
      JwtAuthGuard, { provide: PrismaService, useValue: db },
      { provide: AuthService, useValue: { authenticateJwt: async (token: string) => {
        if (!['one', 'two', 'blocked'].includes(token)) throw new UnauthorizedException();
        return { idUsuario: token === 'two' ? 8 : 7, status: token === 'blocked' ? 'BLOQUEADO' : 'ATIVO' };
      } } },
    ] }).compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    try {
      const url = await app.getUrl();
      const request = (token?: string, body?: object) => fetch(`${url}/point-fantasy/participante/brasao`, {
        method: body ? 'PATCH' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect((await request()).status).toBe(401);
      expect((await request('bad')).status).toBe(401);
      expect((await request('blocked', { brasaoId: CREST_IDS[0] })).status).toBe(403);
      expect((await request('one', { brasaoId: 'invalid' })).status).toBe(400);
      expect((await request('one', { brasaoId: CREST_IDS[0], usuarioId: 8 })).status).toBe(400);
      const updated = await request('one', { brasaoId: CREST_IDS[0] });
      expect(updated.status).toBe(200);
      expect(updated.headers.get('cache-control')).toBe('private, no-store');
      expect(await (await request('one')).json()).toEqual({ brasaoId: CREST_IDS[0], escolhido: true });
      expect(await (await request('two')).json()).toMatchObject({ escolhido: false });
    } finally { await app.close(); }
  });
});
