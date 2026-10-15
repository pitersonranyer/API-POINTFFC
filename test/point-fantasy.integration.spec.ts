import { PrismaClient } from '@prisma/client';

// Only an explicitly supplied disposable test database may be used. Never use DATABASE_URL.
const databaseUrl = process.env.POINT_FANTASY_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('POINT Fantasy MySQL constraints (rollback)', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.protocol !== 'mysql:' || !/test/i.test(url.pathname)) throw new Error('Use um banco MySQL de testes dedicado');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
  });
  afterAll(async () => { await prisma?.$disconnect(); });
  it('persiste snapshots, FK unsigned, decimais e filtra clubes sem misturar catalogos', async () => {
    const rollback = new Error('ROLLBACK_POINT_FANTASY');
    await expect(prisma.$transaction(async tx => {
      const catalog = await tx.fantasyCatalogo.create({ data: { temporada: 65000, rodada: 38, versao: 4294967000,
        capturadoEm: new Date(), referencias: {}, atletas: { create: [
          { atletaIdExterno: 4000000000, clubeIdExterno: 10, posicaoId: 5, statusId: 7, apelido: 'A', precoCartola: '5.99', categoriaId: 1, pointcoins: 10 },
          { atletaIdExterno: 4000000001, clubeIdExterno: 20, posicaoId: 6, statusId: 7, apelido: 'T', precoCartola: '20.00', categoriaId: null, pointcoins: 10 },
          { atletaIdExterno: 4000000002, clubeIdExterno: 30, posicaoId: 5, statusId: 7, apelido: 'B', precoCartola: '10.00', categoriaId: 3, pointcoins: 30 },
        ] } } });
      const eligible = await tx.fantasyCatalogoAtleta.findMany({ where: { catalogoId: catalog.id, clubeIdExterno: { in: [10, 20] } }, orderBy: { atletaIdExterno: 'asc' } });
      expect(eligible.map(a => a.atletaIdExterno)).toEqual([4000000000, 4000000001]);
      expect(eligible[0].precoCartola.toFixed(2)).toBe('5.99');
      await expect(tx.fantasyCatalogo.create({ data: { temporada: 65000, rodada: 38, versao: 4294967000, capturadoEm: new Date(), referencias: {} } })).rejects.toMatchObject({ code: 'P2002' });
      await expect(tx.fantasyCatalogo.delete({ where: { id: catalog.id } })).rejects.toMatchObject({ code: 'P2003' });
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
