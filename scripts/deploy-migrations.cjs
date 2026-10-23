// Automatic bootstrap migration transport. Never imports the application or collectors.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const migration = '0030_point_fantasy_writer_admission';
const expectedHash = '57b2cb49a10f6a33e6673196fed5986fee120431f3aebeb93f26b57b4d936bb8';
const lockName = 'point_ffc_bootstrap_migrations';

function transport(sql) {
  // This is a pinned script, not an arbitrary SQL parser. Preserve procedure bodies
  // and string literals; only change the mysql CLI's line-ending separators.
  return sql.split(/\r?\n/).filter(line => !/^DELIMITER (?:\$\$|;)\s*$/.test(line))
    .map(line => line.endsWith('$$') ? line.slice(0, -2) + ';' : line).join('\n');
}

function restrictedSchema(root) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'point-ffc-bootstrap-'));
  const migrations = path.join(directory, 'migrations');
  fs.mkdirSync(migrations);
  fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(directory, 'schema.prisma'));
  fs.copyFileSync(path.join(root, 'prisma/migrations/migration_lock.toml'), path.join(migrations, 'migration_lock.toml'));
  for (const entry of fs.readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name >= migration) continue;
    fs.mkdirSync(path.join(migrations, entry.name));
    fs.copyFileSync(path.join(root, 'prisma/migrations', entry.name, 'migration.sql'), path.join(migrations, entry.name, 'migration.sql'));
  }
  return path.join(directory, 'schema.prisma');
}

async function deploy({ db, run, root = path.resolve(__dirname, '..'), makeRestrictedSchema = restrictedSchema }) {
  const schema = path.join(root, 'prisma/schema.prisma');
  const bytes = fs.readFileSync(path.join(root, 'prisma/migrations', migration, 'migration.sql'));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== expectedHash) throw Error('BOOTSTRAP_0030_CHECKSUM_MISMATCH');
  const prisma = (args, input) => run(args, input);
  // Hold a connection-bound lock while Prisma uses separate connections. History
  // writes below deliberately use db, not the lock transaction: failed DDL must
  // leave a committed failure record and must never be retried automatically.
  return db.$transaction(async lock => {
    const [acquired] = await lock.$queryRawUnsafe(`SELECT GET_LOCK('${lockName}',0) AS acquired`);
    if (Number(acquired.acquired) !== 1) throw Error('BOOTSTRAP_MIGRATIONS_BUSY');
    try {
      const [table] = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='_prisma_migrations'");
      let history = table && Number(table.n) > 0
        ? await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations') : [];
      if (history.some(row => !row.finished_at && !row.rolled_back_at)) throw Error('BOOTSTRAP_FAILED_MIGRATION_REQUIRES_REVIEW');
      const applied = history.filter(row => row.migration_name === migration && row.finished_at && !row.rolled_back_at);
      if (applied.length > 1 || applied.some(row => row.checksum !== checksum)) throw Error('BOOTSTRAP_0030_HISTORY_MISMATCH');
      if (!applied.length) {
        // Prisma applies the unmodified chain through 0029 before the exceptional
        // transport. The permanent schema and all migration files stay untouched.
        prisma(['migrate', 'deploy', '--schema', makeRestrictedSchema(root)]);
        history = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations');
        if (!history.some(row => row.migration_name === '0029_point_fantasy_current_scoring' && row.finished_at && !row.rolled_back_at)
          || history.some(row => row.migration_name >= migration && row.finished_at && !row.rolled_back_at)) throw Error('BOOTSTRAP_UNEXPECTED_MIGRATION_BOUNDARY');
        // New production observation tables must be empty. Existing observations
        // require an explicit writer cutover, never an automatic bootstrap.
        for (const tableName of ['FANTASY_APURACAO_RODADA', 'FANTASY_PONTUACAO_COLETA', 'FANTASY_PONTUACAO_SNAPSHOT', 'FANTASY_PONTUACAO_ATLETA_SNAPSHOT', 'FANTASY_PONTUACAO_ATLETA']) {
          const [row] = await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM `' + tableName + '`');
          if (Number(row.n) !== 0) throw Error('BOOTSTRAP_OBSERVATION_DATA_REQUIRES_REVIEW');
        }
        const id = randomUUID();
        await db.$executeRawUnsafe('INSERT INTO _prisma_migrations (id,checksum,migration_name,started_at,applied_steps_count,logs) VALUES (?,?,?,UTC_TIMESTAMP(3),0,?)',
          id, checksum, migration, 'POINT_FFC: automatic bootstrap started; DDL is not transactional');
        try {
          prisma(['db', 'execute', '--stdin', '--schema', schema], transport(bytes.toString('utf8')));
          await db.$executeRawUnsafe('CALL FANTASY_VERIFY_ADMISSION()');
          const changed = await db.$executeRawUnsafe('UPDATE _prisma_migrations SET finished_at=UTC_TIMESTAMP(3),applied_steps_count=1,logs=NULL WHERE id=? AND finished_at IS NULL AND rolled_back_at IS NULL', id);
          if (changed !== 1) throw Error('BOOTSTRAP_0030_COMPLETION_CONFLICT');
        } catch (error) {
          await db.$executeRawUnsafe('UPDATE _prisma_migrations SET logs=? WHERE id=? AND finished_at IS NULL',
            'POINT_FFC: automatic bootstrap failed; partial DDL possible; manual review required; do not retry or resolve without schema verification', id);
          throw error;
        }
      }
      prisma(['migrate', 'deploy', '--schema', schema]);
    } finally {
      await lock.$queryRawUnsafe(`SELECT RELEASE_LOCK('${lockName}')`);
    }
  }, { timeout: 1200000, maxWait: 10000 });
}

async function main() {
  if (process.env.NODE_ENV !== 'production') throw Error('AUTOMATIC_PRODUCTION_BOOTSTRAP_ONLY');
  const db = new PrismaClient();
  try {
    await deploy({ db, run: (args, input) => execFileSync(process.execPath, [require.resolve('prisma'), ...args], {
      env: process.env, ...(input === undefined ? { stdio: 'inherit' } : { input, stdio: ['pipe', 'inherit', 'inherit'] }),
    }) });
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(error => {
  console.error(/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'BOOTSTRAP_MIGRATIONS_FAILED: inspect preceding migration output and history before intervention');
  process.exitCode = 1;
});
module.exports = { deploy, transport, restrictedSchema, migration, expectedHash };
