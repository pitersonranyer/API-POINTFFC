import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(__dirname, '../prisma/migrations/0020_desafio_multiplas_inscricoes/migration.sql'), 'utf8');
const antiga = readFileSync(join(__dirname, '../prisma/migrations/0019_desafio/migration.sql'), 'utf8');
const statements = (sql: string) => sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);

describe('Contrato de persistencia e backfill das cartelas', () => {
  const model = (name: string) => Prisma.dmmf.datamodel.models.find(m => m.name === name)!;

  it('default 1 preserva o limite e sequencia das participacoes existentes', () => {
    expect(model('Desafio').fields.find(f => f.name === 'limiteInscricoesPorUsuario')).toMatchObject({ default: 1, isRequired: true });
    expect(model('DesafioInscricao').fields.find(f => f.name === 'sequencia')).toMatchObject({ default: 1, isRequired: true });
    expect(migration).toContain('`LIMITE_INSCRICOES_POR_USUARIO` INTEGER UNSIGNED NOT NULL DEFAULT 1');
    expect(migration).toContain('`SEQUENCIA` INTEGER UNSIGNED NOT NULL DEFAULT 1');
    expect(migration).not.toMatch(/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  });

  it('vincula existentes antes de exigir FK/NOT NULL e preserva palpites ainda sem inscricao', () => {
    expect(migration).toContain("p.`USUARIO_ID`, 'RASCUNHO', 1, 0");
    expect(migration).toContain('WHERE i.`ID` IS NULL');
    expect(migration).toContain('AND i.`USUARIO_ID` = p.`USUARIO_ID` AND i.`SEQUENCIA` = 1');
    expect(migration.indexOf('INSERT INTO')).toBeLessThan(migration.indexOf('UPDATE `DESAFIO_PALPITE`'));
    expect(migration.indexOf('SET p.`INSCRICAO_ID` = i.`ID`')).toBeLessThan(migration.indexOf('MODIFY COLUMN `INSCRICAO_ID`'));
    expect(migration).not.toMatch(/SET\s+(?:p\.)?`(?:PALPITE|PONTOS|APURADO|MOVIMENTACAO_DEBITO_ID)`/i);
  });

  it('garante palpite unico por cartela/partida e impede dono ou desafio divergente', () => {
    expect(model('DesafioPalpite').uniqueFields).toContainEqual(['inscricaoId', 'desafioPartidaId']);
    expect(model('DesafioPalpite').uniqueFields).not.toContainEqual(['desafioPartidaId', 'usuarioId']);
    expect(model('DesafioPalpite').fields.find(f => f.name === 'inscricao')).toMatchObject({
      relationFromFields: ['inscricaoId', 'desafioId', 'usuarioId'], relationToFields: ['id', 'desafioId', 'usuarioId'], relationOnDelete: 'Restrict',
    });
    expect(model('DesafioInscricao').uniqueFields).toContainEqual(['desafioId', 'usuarioId', 'sequencia']);
    expect(model('DesafioInscricao').uniqueFields).toContainEqual(['desafioId', 'usuarioId', 'chaveIdempotencia']);
    expect(model('DesafioInscricao').uniqueFields).not.toContainEqual(['desafioId', 'usuarioId']);
    expect(model('DesafioInscricao').fields.find(f => f.name === 'movimentacaoDebitoId')?.isUnique).toBe(true);
  });
});

// Opt-in somente para banco DESCARTAVEL vazio, com nome contendo "test".
// Nunca le DATABASE_URL. O banco fica com as tabelas/dados para inspecao apos o teste.
const url = process.env.DESAFIO_MIGRATION_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('Migration de cartelas com dados legados em MySQL real', () => {
  const prisma = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  beforeAll(async () => {
    if (!/test/i.test(new URL(url!).pathname)) throw new Error('Exige banco de teste descartavel.');
    await prisma.$connect();
    const tables = await prisma.$queryRawUnsafe<unknown[]>('SHOW TABLES');
    if (tables.length) throw new Error('Exige banco vazio; nenhuma tabela existente sera alterada.');
    await prisma.$executeRawUnsafe('CREATE TABLE USUARIO (id_usuario INTEGER UNSIGNED PRIMARY KEY)');
    await prisma.$executeRawUnsafe('CREATE TABLE MOVIMENTACAO_CARTEIRA (id INTEGER UNSIGNED PRIMARY KEY)');
    for (const sql of statements(antiga)) await prisma.$executeRawUnsafe(sql);
    await prisma.$executeRawUnsafe('INSERT INTO USUARIO VALUES (1), (2), (3)');
    await prisma.$executeRawUnsafe('INSERT INTO MOVIMENTACAO_CARTEIRA VALUES (50)');
    await prisma.$executeRawUnsafe(`INSERT INTO DESAFIO
      (ID,NOME,CRIADO_POR_ID,INICIO_INSCRICAO,FIM_INSCRICAO,DATA_INICIO,DATA_FIM,ATUALIZADO_EM)
      VALUES (7,'Legado',1,'2030-01-01','2030-01-02','2030-01-03','2030-01-04','2030-01-01')`);
    await prisma.$executeRawUnsafe(`INSERT INTO DESAFIO_PARTIDA
      (ID,DESAFIO_ID,FIXTURE_ID_API_FOOTBALL,LEAGUE_ID_API_FOOTBALL,NOME_COMPETICAO,MANDANTE_ID_API_FOOTBALL,
       NOME_MANDANTE,VISITANTE_ID_API_FOOTBALL,NOME_VISITANTE,DATA_INICIO,ATUALIZADO_EM)
      VALUES (1,7,100,2013,'Serie A',1783,'CR Flamengo',1769,'Palmeiras','2030-01-03','2030-01-01')`);
    await prisma.$executeRawUnsafe(`INSERT INTO DESAFIO_INSCRICAO
      (ID,DESAFIO_ID,USUARIO_ID,STATUS,VALOR_INSCRICAO,MOVIMENTACAO_DEBITO_ID,ATUALIZADO_EM)
      VALUES (10,7,1,'ATIVA',2,50,'2030-01-01'),(11,7,2,'CANCELADA',0,NULL,'2030-01-01')`);
    await prisma.$executeRawUnsafe(`INSERT INTO DESAFIO_PALPITE
      (ID,DESAFIO_ID,DESAFIO_PARTIDA_ID,USUARIO_ID,PALPITE,PONTOS,APURADO,ATUALIZADO_EM)
      VALUES (20,7,1,1,'CASA',1,true,'2030-01-01'),(21,7,1,2,'FORA',0,true,'2030-01-01'),
             (22,7,1,3,'EMPATE',NULL,false,'2030-01-01')`);
    for (const sql of statements(migration)) await prisma.$executeRawUnsafe(sql);
  }, 60000);
  afterAll(() => prisma.$disconnect());

  it('mantem IDs, snapshots, pontos e cancelamento; cria somente rascunho para orfao', async () => {
    expect((await prisma.desafio.findUniqueOrThrow({ where: { id: 7 } })).limiteInscricoesPorUsuario).toBe(1);
    const inscricoes = await prisma.desafioInscricao.findMany({ orderBy: { usuarioId: 'asc' } });
    expect(inscricoes.map(i => [i.usuarioId, i.sequencia, i.status])).toEqual([[1, 1, 'ATIVA'], [2, 1, 'CANCELADA'], [3, 1, 'RASCUNHO']]);
    expect(inscricoes[0]).toMatchObject({ id: 10, movimentacaoDebitoId: 50 });
    expect(inscricoes[0].valorInscricao.toFixed(2)).toBe('2.00');
    const palpites = await prisma.desafioPalpite.findMany({ orderBy: { id: 'asc' } });
    expect(palpites.map(p => [p.id, p.inscricaoId, p.palpite, p.pontos?.toNumber() ?? null, p.apurado]))
      .toEqual([[20, 10, 'CASA', 1, true], [21, 11, 'FORA', 0, true], [22, inscricoes[2].id, 'EMPATE', null, false]]);
  });

  it('aceita outra cartela para a mesma partida; rejeita duplicata e dono divergente', async () => {
    const inscricao = await prisma.desafioInscricao.create({ data: { desafioId: 7, usuarioId: 1, sequencia: 2, status: 'RASCUNHO' } });
    const data = { desafioId: 7, usuarioId: 1, inscricaoId: inscricao.id, desafioPartidaId: 1, palpite: 'FORA' as const };
    await prisma.desafioPalpite.create({ data });
    await expect(prisma.desafioPalpite.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    const outra = await prisma.desafioInscricao.create({ data: { desafioId: 7, usuarioId: 1, sequencia: 3, status: 'RASCUNHO' } });
    await expect(prisma.desafioPalpite.create({ data: { ...data, inscricaoId: outra.id, usuarioId: 2 } }))
      .rejects.toMatchObject({ code: 'P2003' });
  });
});
