import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AdicionarTimeDto } from '../src/meus-times/dto/adicionar-time.dto';
import { MeusTimesService } from '../src/meus-times/meus-times.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Usa apenas um MySQL dedicado previamente migrado; nunca executa migration nem usa DATABASE_URL.
const databaseUrl = process.env.CARTEIRA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('MeusTimesService - associação única Cartola em MySQL', () => {
  const prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  const service = new MeusTimesService(prisma as PrismaService);
  const dto = (timeId: number): AdicionarTimeDto => ({ timeId, nome: `Telegram ${timeId}` });
  let usuarios: number[] = [];
  let timeId = 0;

  beforeAll(() => prisma.$connect());
  beforeEach(async () => {
    const token = randomUUID();
    const a = await prisma.usuario.create({ data: { email: `meus-times-a-${token}@example.invalid` } });
    const b = await prisma.usuario.create({ data: { email: `meus-times-b-${token}@example.invalid` } });
    usuarios = [a.idUsuario, b.idUsuario];
    timeId = 3_000_000_000 + Math.floor(Math.random() * 900_000_000);
  });
  afterEach(async () => {
    await prisma.timeUsuario.deleteMany({ where: { timeId } });
    await prisma.usuario.deleteMany({ where: { idUsuario: { in: usuarios } } });
  });
  afterAll(() => prisma.$disconnect());

  it('serializa duas associações concorrentes: só um perfil fica associado', async () => {
    const results = await Promise.all(usuarios.map(usuarioId => service.adicionarTime(usuarioId, dto(timeId))));
    expect(results.map(result => result.status).sort()).toEqual(['adicionado', 'ja_existente']);
    const persisted = await prisma.timeUsuario.findMany({ where: { timeId } });
    expect(persisted).toHaveLength(1);
    expect(usuarios).toContain(persisted[0].usuarioId);
  });

  it('trata repetição do mesmo perfil sem duplicar nem retornar identidade de outro perfil', async () => {
    await expect(service.adicionarTime(usuarios[0], dto(timeId))).resolves.toEqual({ status: 'adicionado', timeId });
    await expect(service.adicionarTime(usuarios[0], dto(timeId))).resolves.toEqual({ status: 'ja_existente', timeId });
    await expect(service.adicionarTime(usuarios[1], dto(timeId))).resolves.toEqual({ status: 'ja_existente', timeId });
    expect(await prisma.timeUsuario.count({ where: { timeId } })).toBe(1);
  });
});
