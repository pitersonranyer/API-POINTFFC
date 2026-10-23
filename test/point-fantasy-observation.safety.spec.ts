import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const safety = require('../scripts/point-fantasy-observation-safety.cjs');

describe('migration helper safety (simulated actions only)', () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-safety-test-'));
    const put = (name: string, text = '{}') => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    for (const f of ['package.json', 'prisma/schema.prisma', 'tsconfig.json', 'tsconfig.build.json',
      'src/point-fantasy/observation/service.ts', 'src/prisma/service.ts', 'scripts/point-fantasy-observe.cjs',
      'test/point-fantasy-observation.example.spec.ts', 'prisma/migrations/0028_observation/migration.sql']) put(f);
    let target = 'mysql://user:password@localhost:3306/local_dev';
    let history: unknown[] = [];
    const current = () => safety.capture(root, target, history);
    const state: any = { formatVersion: 2, context: current(), rehearsalId: 'rehearsal',
      rehearsal: { success: true, testSchema: 'point_fantasy_observation_3b2_test_123' }, testSchema: 'point_fantasy_observation_3b2_test_123', testsPassed: false };
    const save = jest.fn();
    const approve = () => safety.runApprovedTests({ state, save, current, run: () => ({ status: 0 }) });
    return { put, current, state, save, approve, target: (s: string) => { target = s; }, history: (h: unknown[]) => { history = h; } };
  }
  it.each(['new migration', 'changed SQL', 'history', 'destination', 'code', 'tests'])('refuses apply after %s changes', async kind => {
    const f = fixture(); await f.approve();
    if (kind === 'new migration') f.put('prisma/migrations/0029_unrehearsed/migration.sql', 'unrehearsed');
    if (kind === 'changed SQL') f.put('prisma/migrations/0028_observation/migration.sql', 'changed');
    if (kind === 'history') f.history([{ migration_name: '0028_observation', finished_at: 'done', rolled_back_at: null }]);
    if (kind === 'destination') f.target('mysql://user:password@localhost:3306/other');
    if (kind === 'code') f.put('src/point-fantasy/observation/service.ts', 'changed');
    if (kind === 'tests') f.put('test/point-fantasy-observation.example.spec.ts', 'changed');
    const deploy = jest.fn();
    expect(() => { safety.assertApply(f.state, f.current()); deploy(); }).toThrow();
    expect(deploy).not.toHaveBeenCalled();
  });
  it('refuses legacy approval and approval without successful rehearsal', async () => {
    const f = fixture(); await f.approve();
    expect(() => safety.assertApply({ ...f.state, formatVersion: 1 }, f.current())).toThrow('REHEARSAL_REQUIRED');
    expect(() => safety.assertApply({ ...f.state, rehearsal: { success: false } }, f.current())).toThrow();
  });
  it('invalidates success before a failing test attempt', async () => {
    const f = fixture(); await f.approve();
    await expect(safety.runApprovedTests({ ...f, run: () => {
      expect(f.state.testsPassed).toBe(false); expect(f.state.approval).toBeNull(); return { status: 1 };
    } })).rejects.toThrow('ISOLATED_TESTS_FAILED');
    expect(f.state.testsPassed).toBe(false); expect(f.state.testAttempt.outcome).toBe('FAILED');
    expect(() => safety.assertApply(f.state, f.current())).toThrow('VALID_TEST_APPROVAL_REQUIRED');
  });
  it.each(['spawn error', 'signal', 'during test', 'schema'])('does not approve %s', async kind => {
    const f = fixture();
    if (kind === 'schema') f.state.testSchema = 'shared_dev';
    await expect(safety.runApprovedTests({ ...f, run: () => {
      if (kind === 'during test') f.put('test/point-fantasy-observation.example.spec.ts', 'changed while running');
      return { status: 0, error: kind === 'spawn error' ? new Error('failed') : undefined, signal: kind === 'signal' ? 'SIGTERM' : null };
    } })).rejects.toThrow();
    expect(f.state.approval).toBeNull();
  });
  it('accepts exact successful manifest and does not store credentials', async () => {
    const f = fixture(); await f.approve(); expect(() => safety.assertApply(f.state, f.current())).not.toThrow();
    expect(JSON.stringify(f.state)).not.toContain('password');
  });
});
