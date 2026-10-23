import { rankScores, scoreLineup, ScoringPlayer } from '../src/point-fantasy/scoring/scoring-engine';

export function scoringPlayers(): ScoringPlayer[] {
  const positions = [1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5, 6, 1, 2, 3, 4, 5];
  return positions.map((position, index) => ({ id: index + 1, position,
    role: index < 11 ? 'TITULAR' : index === 11 ? 'TECNICO' : 'RESERVA',
    points: index < 12 ? '1' : '0', played: true }));
}
describe('POINT FFC 3C scoring (memory only)', () => {
  let players: ScoringPlayer[];
  beforeEach(() => { players = scoringPlayers(); });
  const patch = (id: number, value: Partial<ScoringPlayer>) => Object.assign(players.find(p => p.id === id)!, value);
  const run = (captain = 1, mago = 13) => scoreLineup(players, captain, mago);

  it.each([['3.15', '18.3'], ['-3.15', '5.7']])('doubles captain %s and includes official coach', (points, total) => {
    patch(1, { points }); patch(12, { points: '2' }); expect(run(1, 16).total).toBe(total);
  });
  it('preserves 18 decimal places while summing and doubling', () => {
    patch(1, { points: '0.123456789123456789' });
    expect(run().total).toBe('11.246913578246913578');
  });
  it('common reserve replaces only a known nonparticipant in its position', () => {
    patch(2, { played: false, points: null }); patch(14, { points: '5' });
    expect(run().substitutions).toEqual([expect.objectContaining({ out: 2, in: 14, kind: 'COMUM', contribution: '5' })]);
    expect(run().total).toBe('17');
  });
  it('negative common reserve enters with zero', () => {
    patch(2, { played: false }); patch(14, { points: '-5' });
    expect(run().substitutions).toEqual([expect.objectContaining({ in: 14, contribution: '0', officialPoints: '-5' })]);
  });
  it('Mago replaces the lowest original starter in the same position', () => {
    patch(6, { points: '4' }); patch(7, { points: '-2' }); patch(16, { points: '3' });
    expect(run(1, 16).substitutions).toEqual([expect.objectContaining({ out: 7, in: 16, kind: 'MAGO' })]);
  });
  it('negative Mago improves a more negative starter without clamping', () => {
    patch(1, { points: '-5' }); patch(13, { points: '-2' });
    expect(run().total).toBe('7');
    expect(run().substitutions[0]).toMatchObject({ kind: 'MAGO', contribution: '-4', multiplier: 2 });
  });
  it('common replacement inherits captain multiplier', () => {
    patch(1, { played: false }); patch(13, { points: '4' });
    expect(run().substitutions[0]).toMatchObject({ multiplier: 2, contribution: '8' });
    expect(run().total).toBe('19');
  });
  it('optimizes conflicting common and Mago use with no duplicate reserve', () => {
    patch(2, { played: false }); patch(3, { points: '-6' }); patch(14, { points: '4' });
    const result = run(1, 14);
    expect(result.substitutions).toEqual([expect.objectContaining({ out: 3, in: 14, kind: 'MAGO' })]);
    expect(result.total).toBe('15');
  });
  it('compares captain-weighted gain for tied lowest starters', () => {
    patch(6, { points: '-1' }); patch(7, { points: '-1' }); patch(16, { points: '3' });
    expect(run(7, 16).substitutions[0]).toMatchObject({ out: 7, multiplier: 2 });
  });
  it('does not use absent or unimproving Mago', () => {
    patch(13, { played: false, points: '100' }); expect(run().substitutions).toEqual([]);
  });
  it('does not turn missing information into zero', () => {
    patch(2, { points: null, played: null });
    expect(run()).toMatchObject({ total: null, missing: [2], substitutions: [] });
  });
  it('missing reserve information also prevents an invented optimum', () => {
    patch(14, { points: null }); expect(run()).toMatchObject({ total: null, missing: [14] });
  });
  it('never uses one reserve twice', () => {
    patch(2, { played: false }); patch(3, { played: false }); patch(14, { points: '5' });
    expect(run().substitutions).toHaveLength(1);
  });
  it('Mago chooses the lowest remaining starter after a common replacement (two centre backs on bench)', () => {
    const positions = [1, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 6, 1, 3, 3, 4, 5];
    players.forEach((p, i) => { p.position = positions[i]; });
    patch(2, { played: false }); patch(4, { points: '2' });
    patch(14, { points: '4' }); patch(15, { points: '5' });
    expect(run(1, 15).substitutions).toEqual([
      expect.objectContaining({ out: 2, in: 14, kind: 'COMUM' }),
      expect.objectContaining({ out: 3, in: 15, kind: 'MAGO' }),
    ]);
    expect(run(1, 15).total).toBe('21');
  });
  it('is deterministic regardless of database order', () => {
    patch(2, { played: false }); patch(3, { played: false }); patch(14, { points: '4' });
    expect(scoreLineup([...players].reverse(), 1, 13)).toEqual(run());
  });
  it('preserves competition ranks and stable presentation across ties', () => {
    expect(rankScores([{ escalacaoId: 3, total: '8' }, { escalacaoId: 2, total: '10' },
      { escalacaoId: 1, total: '10.00' }, { escalacaoId: 4, total: null }]).map(r => [r.escalacaoId, r.posicao]))
      .toEqual([[1, 1], [2, 1], [3, 3], [4, null]]);
  });
});
