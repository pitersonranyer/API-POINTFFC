import { localScoringDestination, assertLocalRuntime, assertLocalScoringScope, LocalScoringAuthorization } from '../src/point-fantasy/observation/local-scoring-authorization';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseArgs } = require('../scripts/point-fantasy-collect-local.cjs');
describe('local scoring CLI and environment boundary', () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  it('requires explicit season, round, UUID and approval file', () => {
    expect(parseArgs(['2026', '31', uuid, '--authorization', 'approval.json'])).toMatchObject({ season: 2026, round: 31, operationId: uuid, prepare: false });
    expect(parseArgs(['prepare', '2026', '31', uuid, '--authorization', 'approval.json']).prepare).toBe(true);
    expect(parseArgs(['prepare-review','2026','31',uuid,'--authorization','review.json','--review','12'])).toMatchObject({prepare:true,prepareReview:true,reviewId:12});
    expect(()=>parseArgs(['prepare-review','2026','31',uuid,'--authorization','review.json','--review','0'])).toThrow();
    for (const args of [[], ['2026', '31'], ['2026','39',uuid,'--authorization','a'], ['2026','31','invalid','--authorization','a'], ['2026','31',uuid,'--authorization','a','extra']]) expect(() => parseArgs(args)).toThrow();
  });
  it.each(['mysql://x:y@localhost/fantasy_point_do_jogador', 'mysql://x:y@db.render.com/fantasy_point_do_jogador', 'mysql://x:y@127.0.0.1:3307/fantasy_point_do_jogador', 'mysql://x:y@127.0.0.1/other', 'mysql://x:y@127.0.0.1/fantasy_point_do_jogador?socket=remote', 'postgres://x:y@127.0.0.1/fantasy_point_do_jogador', 'mysql://x:y@127.0.0.1/point_fantasy_observation_3b2_test_1'])('refuses CLI destination %s', url => {
    expect(() => localScoringDestination(url, true)).toThrow('ADMISSION_LOCAL_DESTINATION_FORBIDDEN');
  });
  it.each(['NODE_ENV','RENDER','RENDER_SERVICE_ID','RENDER_EXTERNAL_HOSTNAME'])('refuses production/Render via %s', key => {
    const old = process.env[key]; try { process.env[key] = key === 'NODE_ENV' ? 'production' : 'present'; expect(() => assertLocalRuntime()).toThrow('ADMISSION_LOCAL_ENVIRONMENT_FORBIDDEN'); }
    finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  });
  it('cannot fabricate an in-memory authorization from a JSON object', () => {
    expect(() => assertLocalScoringScope({} as LocalScoringAuthorization, 'mysql://x:y@127.0.0.1/fantasy_point_do_jogador', 2026, 31, uuid)).toThrow('ADMISSION_LOCAL_SCOPE_MISMATCH');
  });
  it('the actual CLI rejects isolated URLs before opening a connection or reading approval', () => {
    const run = spawnSync(process.execPath, [resolve(__dirname, '../scripts/point-fantasy-collect-local.cjs'), '2026','31',uuid,'--authorization','file-that-does-not-exist.json'], {
      env: { ...process.env, DATABASE_URL: 'mysql://x:y@127.0.0.1:3306/point_fantasy_observation_3b2_test_1' }, encoding: 'utf8',
    });
    expect(run.status).toBe(1); expect(JSON.parse(run.stderr)).toEqual({ error: 'ADMISSION_LOCAL_DESTINATION_FORBIDDEN' });
  });
});
