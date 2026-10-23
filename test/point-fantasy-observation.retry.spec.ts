import { Prisma } from '@prisma/client';
import { isObservationDeadlock, retryObservationTransaction } from '../src/point-fantasy/observation/observation-retry';
import { persistenceCode } from '../src/point-fantasy/observation/observation-errors';

const known = (code: string, mysqlCode?: unknown) => new Prisma.PrismaClientKnownRequestError('private SQL and password', {
  code, clientVersion: Prisma.prismaVersion.client, meta: mysqlCode === undefined ? undefined : { code: mysqlCode },
});
describe('bounded observation transaction retries', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });
  it.each([known('P2034'), known('P2010', '1213'), known('P2010', 1213)])('retries a proven transaction conflict and returns its result %#', async error => {
    const run = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('committed');
    const assertion = expect(retryObservationTransaction(run)).resolves.toBe('committed');
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(24); expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); await assertion;
    expect(run).toHaveBeenCalledTimes(2);
    expect(persistenceCode(error, 'COMMIT')).toBe('DB_TRANSACTION_CONFLICT_COMMIT');
  });
  it.each([known('P2010'), known('P2010','1205'), known('P2010','1064'), known('P2010','1452'),
    known('P2010','1213 '), known('P2003'), known('P2002'), new Error('deadlock 1213'),
    { code: 'P2010', meta: { code: '1213' } }])('does not retry unrelated, permanent or unverified errors %#', async error => {
    const run = jest.fn().mockRejectedValue(error);
    expect(isObservationDeadlock(error)).toBe(false);
    await expect(retryObservationTransaction(run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  it.each([known('P2034'), known('P2010','1213')])('stops after four full transaction attempts and 25/50/75ms backoff %#', async error => {
    const run = jest.fn().mockRejectedValue(error); const start = Date.now();
    const assertion = expect(retryObservationTransaction(run)).rejects.toBe(error);
    await jest.runAllTimersAsync(); await assertion;
    expect(run).toHaveBeenCalledTimes(4); expect(Date.now() - start).toBe(150);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('retains UUID uniqueness-race retry only when acquisition explicitly opts in', async () => {
    const run = jest.fn().mockRejectedValueOnce(known('P2002')).mockResolvedValue('existing operation');
    const assertion = expect(retryObservationTransaction(run, true)).resolves.toBe('existing operation');
    await jest.runAllTimersAsync(); await assertion; expect(run).toHaveBeenCalledTimes(2);
  });
});
