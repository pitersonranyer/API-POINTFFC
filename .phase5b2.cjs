const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert/strict');
const { PrismaClient } = require('@prisma/client');
const stateFile = '.phase5b2-state.json';
function localUrl() {
  const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find(l => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) throw new Error('LOCAL_CONFIGURATION_MISSING');
  let value = line.slice(line.indexOf('=') + 1).trim();
  if ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'")) value = value.slice(1, -1);
  const url = new URL(value);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  return url;
}
function testUrl(name) {
  assert.match(name, /^point_fantasy_lineups_2a_test_[a-z0-9_]+$/);
  const url = localUrl(); url.pathname = '/' + name; return url;
}
function client(url) { return new PrismaClient({ datasources: { db: { url: url.toString() } } }); }
function run(label, args, url, envExtra = {}) {
  const result = cp.spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url.toString(), ...envExtra }, timeout: 300000 });
  let output = (result.stdout || '') + (result.stderr || '');
  for (const secret of [url.toString(), url.password, decodeURIComponent(url.password)].filter(Boolean)) output = output.split(secret).join('[REDACTED]');
  fs.writeFileSync('.phase5b2-' + label + '.log', output);
  console.log(label + ' exit code: ' + result.status);
  if (result.status !== 0) { console.log(output); throw new Error(label + '_FAILED_STOP'); }
}
async function main() {
  const stage = process.argv[2];
  if (stage === 'prepare') {
    assert.ok(!fs.existsSync(stateFile), 'State already exists; inspect before continuing');
    const name = 'point_fantasy_lineups_2a_test_phase5b2_' + Date.now();
    const url = testUrl(name), adminUrl = localUrl(); adminUrl.pathname = '/information_schema';
    const admin = client(adminUrl);
    try {
      const existing = await admin.$queryRaw`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${name}`;
      assert.equal(existing.length, 0);
      // Identifier is generated locally and constrained above; never reuses an existing database.
      await admin.$executeRawUnsafe('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    } finally { await admin.$disconnect(); }
    fs.writeFileSync(stateFile, JSON.stringify({ name }, null, 2));
    const db = client(url);
    try {
      const tables = await db.$queryRaw`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`;
      assert.equal(tables.length, 0);
      console.log('New dedicated empty local database: ' + name);
    } finally { await db.$disconnect(); }
    const root = path.resolve('.phase5b2-prisma');
    assert.ok(!fs.existsSync(root));
    fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
    fs.copyFileSync('prisma/schema.prisma', path.join(root, 'schema.prisma'));
    for (const entry of fs.readdirSync('prisma/migrations')) {
      if (entry.startsWith('0026_')) continue;
      fs.cpSync(path.join('prisma/migrations', entry), path.join(root, 'migrations', entry), { recursive: true });
    }
    run('migrations-through-0025', ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', path.join(root, 'schema.prisma')], url);
    console.log('Migrations through 0025 applied; stop point before legacy fixture and 0026.');
    return;
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')), url = testUrl(state.name);
  if (stage === 'legacy-and-migrate') {
    const db = client(url);
    try {
      const applied = await db.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      assert.equal(applied.length, 25);
      assert.ok(!applied.some(row => row.migration_name.startsWith('0026_')));
      const user = await db.usuario.create({ data: { email: 'phase5b2-legacy@test.invalid', status: 'ATIVO' } });
      const catalog = await db.fantasyCatalogo.create({ data: { temporada: 65000, rodada: 37, versao: 1, status: 'CONGELADO', capturadoEm: new Date(), referencias: {} } });
      const competition = await db.fantasyCompeticao.create({ data: { catalogoId: catalog.id, nome: 'Legacy migration verification', temporada: 65000, rodada: 37, status: 'PUBLICADA', inicioInscricao: new Date(0), fimInscricao: new Date('2098-01-01'), partidas: { create: { partidaIdExterno: 4000000001, clubeMandanteId: 10, clubeVisitanteId: 20, inicioPrevisto: new Date('2099-01-01') } } } });
      await db.$executeRaw`INSERT INTO FANTASY_ESCALACAO (USUARIO_ID, COMPETICAO_ID, FORMACAO, STATUS, VERSAO, CRIADO_EM, ATUALIZADO_EM) VALUES (${user.idUsuario}, ${competition.id}, '4-3-3', 'RASCUNHO', 1, NOW(3), NOW(3))`;
      const before = await db.$queryRaw`SELECT * FROM FANTASY_ESCALACAO WHERE USUARIO_ID = ${user.idUsuario} AND COMPETICAO_ID = ${competition.id}`;
      assert.equal(before.length, 1);
      Object.assign(state, { legacyUser: user.idUsuario, legacyCompetition: competition.id, legacyId: before[0].ID, legacyBefore: JSON.parse(JSON.stringify(before[0])) });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } finally { await db.$disconnect(); }
    run('migration-0026', ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], url);
    return;
  }
  if (stage === 'verify') {
    const db = client(url);
    try {
      const migrations = await db.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
      assert.equal(migrations.length, 26);
      assert.equal(migrations.at(-1).migration_name, '0026_point_fantasy_team_identity');
      const after = await db.$queryRaw`SELECT * FROM FANTASY_ESCALACAO WHERE ID = ${state.legacyId}`;
      const normalized = JSON.parse(JSON.stringify(after[0]));
      for (const [key, value] of Object.entries(state.legacyBefore)) assert.deepEqual(normalized[key], value);
      for (const key of ['IDENTIDADE_ID', 'NOME_PUBLICO', 'SEQUENCIAL']) assert.equal(normalized[key], null);
      const indexes = await db.$queryRaw`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('FANTASY_TIME_IDENTIDADE', 'FANTASY_ESCALACAO', 'FANTASY_TIME_OPERACAO') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;
      const expected = { FTI_USUARIO_COMP_key: ['USUARIO_ID', 'COMPETICAO_ID'], FTI_OWNER_key: ['ID', 'USUARIO_ID', 'COMPETICAO_ID'], FE_IDENTIDADE_SEQ_key: ['IDENTIDADE_ID', 'SEQUENCIAL'], FE_COMP_NOME_key: ['COMPETICAO_ID', 'NOME_PUBLICO'], FTO_IDENTIDADE_CHAVE_key: ['IDENTIDADE_ID', 'CHAVE'], FANTASY_TIME_IDENTIDADE_IDENTIFICADOR_PUBLICO_key: ['IDENTIFICADOR_PUBLICO'] };
      for (const [name, columns] of Object.entries(expected)) {
        const rows = indexes.filter(row => row.INDEX_NAME === name);
        assert.deepEqual(rows.map(row => row.COLUMN_NAME), columns);
        assert.ok(rows.every(row => Number(row.NON_UNIQUE) === 0));
      }
      const fk = await db.$queryRaw`SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'FANTASY_ESCALACAO_IDENTIDADE_ID_USUARIO_ID_COMPETICAO_ID_fkey' ORDER BY ORDINAL_POSITION`;
      assert.deepEqual(fk.map(row => row.COLUMN_NAME), ['IDENTIDADE_ID', 'USUARIO_ID', 'COMPETICAO_ID']);
      assert.deepEqual(fk.map(row => row.REFERENCED_COLUMN_NAME), ['ID', 'USUARIO_ID', 'COMPETICAO_ID']);
      assert.ok(fk.every(row => row.REFERENCED_TABLE_NAME === 'FANTASY_TIME_IDENTIDADE'));
      require('ts-node/register');
      const { LineupService } = require('./src/point-fantasy/lineups/lineup.service');
      const service = new LineupService(db);
      const page = { page: 1, limit: 50 };
      assert.equal((await service.list(state.legacyUser, state.legacyCompetition, page)).estadoIdentidade, 'LEGADO');
      assert.equal((await service.get(state.legacyUser, state.legacyId)).legado, true);
      const copy = await service.duplicate(state.legacyUser, state.legacyId, 1, { nomeBase: 'Legado preservado', chaveIdempotencia: 'legacy-copy' });
      assert.equal(copy.sequencial, 1);
      assert.equal((await service.get(state.legacyUser, state.legacyId)).nomePublico, null);
      const edited = await service.update(state.legacyUser, state.legacyId, { versao: 1, formacao: '4-4-2' });
      assert.equal(edited.legado, true);
      await service.remove(state.legacyUser, state.legacyId, edited.versao);
      await service.remove(state.legacyUser, copy.id, 1);
      assert.equal((await service.list(state.legacyUser, state.legacyCompetition, page)).estadoIdentidade, 'DEFINIDA');
      const next = await service.create(state.legacyUser, state.legacyCompetition, { formacao: '4-3-3' });
      assert.equal(next.sequencial, 2);
      assert.equal(next.identidade.identificadorPublico, copy.identidade.identificadorPublico);
      console.log('Verified: 26 migrations, six unique indexes, composite FK, unchanged pre-0026 legacy row, legacy API CRUD/duplicate, persistent identity and sequence.');
    } finally { await db.$disconnect(); }
    return;
  }
  if (stage === 'integration' || stage === 'full') {
    run(stage, ['node_modules/jest/bin/jest.js', '--runInBand', '--silent', ...(stage === 'integration' ? ['point-fantasy-lineup.integration'] : [])], url, { POINT_FANTASY_TEST_DATABASE_URL: url.toString() });
    const output = fs.readFileSync('.phase5b2-' + stage + '.log', 'utf8');
    console.log(output.split(/\r?\n/).filter(line => /Test Suites:|Tests:|Time:|FAIL|point-fantasy-lineup.integration/.test(line)).join('\n'));
    return;
  }
  throw new Error('UNKNOWN_STAGE');
}
main().catch(error => { console.error('Stopped:', error.code || error.errorCode || error.message.replace(/mysql:\/\/\S+/g, '[REDACTED]')); process.exitCode = 1; });
