// Only fixed labels and allowlisted error metadata may cross the logging boundary.
const types = new Set(['Error', 'TypeError', 'RangeError', 'PrismaClientInitializationError',
  'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientRustPanicError', 'PrismaClientValidationError']);
const guards = new Set(['AUTOMATIC_PRODUCTION_BOOTSTRAP_ONLY', 'BOOTSTRAP_0030_CHECKSUM_MISMATCH',
  'BOOTSTRAP_MIGRATIONS_BUSY', 'BOOTSTRAP_FAILED_MIGRATION_REQUIRES_REVIEW',
  'BOOTSTRAP_0030_HISTORY_MISMATCH', 'BOOTSTRAP_UNEXPECTED_MIGRATION_BOUNDARY',
  'BOOTSTRAP_OBSERVATION_DATA_REQUIRES_REVIEW', 'BOOTSTRAP_0030_COMPLETION_CONFLICT']);
const systemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function errorMetadata(error) {
  const candidate = error?.code ?? error?.errorCode;
  let code = typeof candidate === 'string' && (/^P\d{4}$/.test(candidate) || systemCodes.has(candidate)) ? candidate : 'UNKNOWN';
  if (guards.has(error?.message)) code = error.message;
  // execFileSync retains CLI output privately. Extract only a Prisma error marker.
  if (code === 'UNKNOWN') {
    for (const output of [error?.stderr, error?.stdout]) {
      if (typeof output !== 'string' && !Buffer.isBuffer(output)) continue;
      const match = output.toString().match(/\bError(?: code)?:\s*(P\d{4})\b/);
      if (match) { code = match[1]; break; }
    }
  }
  return { error_code: code, error_type: types.has(error?.name) ? error.name : 'UnknownError' };
}

function diagnostics(write = line => console.log(line), now = () => Date.now()) {
  let active, previous = null;
  const emit = (stage, result, started, extra = {}) => {
    try {
      write(JSON.stringify({ event: 'bootstrap_migrations', stage, result,
        duration_ms: Math.max(0, now() - started), previous_stage: previous, ...extra }));
    } catch { /* Observability must never change migration control flow. */ }
  };
  return {
    begin(stage) { const token = { stage, started: now() }; active = token; emit(stage, 'started', token.started); return token; },
    end(token) {
      if (token.done) return;
      token.done = true;
      emit(token.stage, 'succeeded', token.started);
      previous = { stage: token.stage, result: 'succeeded' };
      if (active === token) active = null;
    },
    fail(error, token = active) {
      if (!token || token.done) return;
      token.done = true;
      emit(token.stage, 'failed', token.started, errorMetadata(error));
      previous = { stage: token.stage, result: 'failed' };
      if (active === token) active = null;
    },
    sync(stage, action) {
      const token = this.begin(stage);
      try { const value = action(); this.end(token); return value; }
      catch (error) { this.fail(error, token); throw error; }
    },
    async step(stage, action) {
      const token = this.begin(stage);
      try { const value = await action(); this.end(token); return value; }
      catch (error) { this.fail(error, token); throw error; }
    },
  };
}

module.exports = { diagnostics, errorMetadata };
