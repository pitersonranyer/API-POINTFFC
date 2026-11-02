// Automatic bootstrap migration transport. Never imports the application or collectors.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { diagnostics } = require('./bootstrap-diagnostics.cjs');
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

function cliEnvironment(environment, originalSchema) {
  const env = { ...environment };
  const url = env.DATABASE_URL;
  if (typeof url !== 'string') return env;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return env;
  const fragmentStart = url.indexOf('#', queryStart);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  // Rewrite only file parameter values: reserializing the whole URL could change
  // credentials, duplicate parameters, escaping or unrelated connection options.
  const query = url.slice(queryStart + 1, queryEnd).split('&').map(parameter => {
    const entry = new URLSearchParams(parameter).entries().next().value;
    if (!entry) return parameter;
    const [key, value] = entry;
    if (!['sslcert', 'sslidentity'].includes(key) || !value || path.isAbsolute(value)) return parameter;
    const equals = parameter.indexOf('=');
    return parameter.slice(0, equals + 1) + encodeURIComponent(path.resolve(path.dirname(originalSchema), value));
  }).join('&');
  env.DATABASE_URL = url.slice(0, queryStart + 1) + query + url.slice(queryEnd);
  return env;
}

async function deploy({ db, run, root = path.resolve(__dirname, '..'), makeRestrictedSchema = restrictedSchema, log = diagnostics() }) {
  const validation = log.begin('artifact_validation');
  const schema = path.join(root, 'prisma/schema.prisma');
  const bytes = fs.readFileSync(path.join(root, 'prisma/migrations', migration, 'migration.sql'));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== expectedHash) throw Error('BOOTSTRAP_0030_CHECKSUM_MISMATCH');
  log.end(validation);
  const prisma = (stage, args, input) => log.sync(stage, () => run(args, input));
  // Hold a connection-bound lock while Prisma uses separate connections. History
  // writes below deliberately use db, not the lock transaction: failed DDL must
  // leave a committed failure record and must never be retried automatically.
  const connection = log.begin('client_connection');
  try {
    return await db.$transaction(async lock => {
      log.end(connection);
      const acquisition = log.begin('lock_acquire');
      const [acquired] = await lock.$queryRawUnsafe(`SELECT GET_LOCK('${lockName}',0) AS acquired`);
      if (Number(acquired.acquired) !== 1) throw Error('BOOTSTRAP_MIGRATIONS_BUSY');
      log.end(acquisition);
      try {
        const historyRead = log.begin('migration_history');
        const [table] = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='_prisma_migrations'");
        let history = table && Number(table.n) > 0
          ? await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations') : [];
        if (history.some(row => !row.finished_at && !row.rolled_back_at)) throw Error('BOOTSTRAP_FAILED_MIGRATION_REQUIRES_REVIEW');
        const applied = history.filter(row => row.migration_name === migration && row.finished_at && !row.rolled_back_at);
        if (applied.length > 1 || applied.some(row => row.checksum !== checksum)) throw Error('BOOTSTRAP_0030_HISTORY_MISMATCH');
        log.end(historyRead);
        if (!applied.length) {
          // Prisma applies the unmodified chain through 0029 before the exceptional
          // transport. The permanent schema and all migration files stay untouched.
          const temporarySchema = log.sync('temporary_schema', () => makeRestrictedSchema(root));
          prisma('cli_through_0029', ['migrate', 'deploy', '--schema', temporarySchema]);
          const boundary = log.begin('migration_boundary');
          history = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations');
          if (!history.some(row => row.migration_name === '0029_point_fantasy_current_scoring' && row.finished_at && !row.rolled_back_at)
            || history.some(row => row.migration_name >= migration && row.finished_at && !row.rolled_back_at)) throw Error('BOOTSTRAP_UNEXPECTED_MIGRATION_BOUNDARY');
          log.end(boundary);
          const observations = log.begin('observation_guard');
          // New production observation tables must be empty. Existing observations
          // require an explicit writer cutover, never an automatic bootstrap.
          for (const tableName of ['FANTASY_APURACAO_RODADA', 'FANTASY_PONTUACAO_COLETA', 'FANTASY_PONTUACAO_SNAPSHOT', 'FANTASY_PONTUACAO_ATLETA_SNAPSHOT', 'FANTASY_PONTUACAO_ATLETA']) {
            const [row] = await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM `' + tableName + '`');
            if (Number(row.n) !== 0) throw Error('BOOTSTRAP_OBSERVATION_DATA_REQUIRES_REVIEW');
          }
          log.end(observations);
          const record = log.begin('migration_0030_history_start');
          const id = randomUUID();
          await db.$executeRawUnsafe('INSERT INTO _prisma_migrations (id,checksum,migration_name,started_at,applied_steps_count,logs) VALUES (?,?,?,UTC_TIMESTAMP(3),0,?)',
            id, checksum, migration, 'POINT_FFC: automatic bootstrap started; DDL is not transactional');
          log.end(record);
          try {
            prisma('cli_transport_0030', ['db', 'execute', '--stdin', '--schema', schema], transport(bytes.toString('utf8')));
            const verification = log.begin('migration_0030_verify');
            await db.$executeRawUnsafe('CALL FANTASY_VERIFY_ADMISSION()');
            log.end(verification);
            const completion = log.begin('migration_0030_history_complete');
            const changed = await db.$executeRawUnsafe('UPDATE _prisma_migrations SET finished_at=UTC_TIMESTAMP(3),applied_steps_count=1,logs=NULL WHERE id=? AND finished_at IS NULL AND rolled_back_at IS NULL', id);
            if (changed !== 1) throw Error('BOOTSTRAP_0030_COMPLETION_CONFLICT');
            log.end(completion);
          } catch (error) {
            log.fail(error);
            const failureRecord = log.begin('migration_0030_history_failure');
            await db.$executeRawUnsafe('UPDATE _prisma_migrations SET logs=? WHERE id=? AND finished_at IS NULL',
              'POINT_FFC: automatic bootstrap failed; partial DDL possible; manual review required; do not retry or resolve without schema verification', id);
            log.end(failureRecord);
            throw error;
          }
        }
        prisma('cli_post_0030', ['migrate', 'deploy', '--schema', schema]);
      } catch (error) {
        log.fail(error);
        throw error;
      } finally {
        await log.step('lock_release', () => lock.$queryRawUnsafe(`SELECT RELEASE_LOCK('${lockName}')`));
      }
    }, { timeout: 1200000, maxWait: 10000 });
  } catch (error) { log.fail(error); throw error; }
}

async function main() {
  const log = diagnostics();
  const bootstrap = log.begin('bootstrap');
  try {
    if (process.env.NODE_ENV !== 'production') throw Error('AUTOMATIC_PRODUCTION_BOOTSTRAP_ONLY');
    const db = new PrismaClient();
    try {
      await deploy({ db, log, run: (args, input) => execFileSync(process.execPath, [require.resolve('prisma'), ...args], {
        env: cliEnvironment(process.env, path.resolve(__dirname, '../prisma/schema.prisma')),
        maxBuffer: Infinity, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }),
      }) });
    } finally { await log.step('client_disconnect', () => db.$disconnect()); }
    log.end(bootstrap);
  } catch (error) { log.fail(error); log.fail(error, bootstrap); throw error; }
}
if (require.main === module) main().catch(() => {
  process.exitCode = 1;
});
module.exports = { deploy, transport, restrictedSchema, cliEnvironment, migration, expectedHash, main };
