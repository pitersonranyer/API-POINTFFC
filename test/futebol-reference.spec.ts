import { competitionReference, ReferenceMatch } from '../src/futebol/futebol-reference.policy';

const now = new Date('2026-09-15T15:00:00Z');
const block = (round: number | null, day: string, count = 10, status = 'TIMED', phase = 'REGULAR_SEASON'): ReferenceMatch[] =>
  Array.from({ length: count }, (_, index) => ({ id: (round ?? 100) * 100 + index, rodada: round, fase: phase,
    dataHoraUtc: `${day}T${String(16 + index % 5).padStart(2, '0')}:00:00Z`, status }));
const season = () => [...block(21, '2026-07-29', 10, 'FINISHED'), ...block(27, '2026-09-13', 10, 'FINISHED'),
  ...block(28, '2026-09-19'), ...block(29, '2026-09-26'), ...block(32, '2026-10-24')];

describe('Referência coletiva da competição (sem banco)', () => {
  it.each(['TIMED', 'SCHEDULED', 'IN_PLAY', 'PAUSED', 'POSTPONED', 'SUSPENDED'])('R21 %s não regride a referência R28', status => {
    const games = season();
    Object.assign(games[0], { status, dataHoraUtc: '2026-09-16T22:30:00Z' });
    const result = competitionReference(games, now);
    expect(result.rodadaReferencia).toBe(28);
    expect(result.partidasPendentes).toEqual([games[0]]);
    expect(result.jogos.every(game => game.rodada === 28)).toBe(true);
  });
  it.each(['TIMED', 'SCHEDULED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'AWARDED'])('R32 %s antecipado não avança sozinho', status => {
    const games = season();
    Object.assign(games.find(game => game.rodada === 32)!, { status, dataHoraUtc: '2026-09-14T19:00:00Z' });
    const result = competitionReference(games, now);
    expect(result.rodadaReferencia).toBe(28);
    expect(result.ultimaRodadaConcluida).toBe(27);
    expect(result.proximaRodada).toBe(29);
  });
  it('TIMED acaba de passar do horário e não troca referência', () => {
    const games = season();
    games.find(game => game.rodada === 28)!.dataHoraUtc = '2026-09-19T15:00:00Z';
    for (const at of ['2026-09-19T14:59:59.999Z', '2026-09-19T15:00:00Z', '2026-09-19T15:00:00.001Z']) {
      expect(competitionReference(games, new Date(at)).rodadaReferencia).toBe(28);
    }
  });
  it('o relógio do jogo atrasado ou antecipado não altera referência', () => {
    const games = season();
    for (const round of [21, 32]) Object.assign(games.find(game => game.rodada === round)!, { status: 'TIMED', dataHoraUtc: '2026-09-15T15:00:00Z' });
    for (const offset of [-1, 0, 1, 60_000]) expect(competitionReference(games, new Date(now.getTime() + offset)).rodadaReferencia).toBe(28);
  });
  it('mantém rodada parcialmente concluída durante seu bloco, inclusive entre dias', () => {
    const games = [...block(27, '2026-09-13', 10, 'FINISHED'), ...block(28, '2026-09-15'), ...block(29, '2026-09-22')];
    games.filter(game => game.rodada === 28).forEach((game, index) => {
      if (index < 7) Object.assign(game, { status: 'FINISHED', dataHoraUtc: '2026-09-14T19:00:00Z' });
    });
    expect(competitionReference(games, now).rodadaReferencia).toBe(28);
    expect(competitionReference(games, now).ultimaRodadaConcluida).toBe(27);
  });
  it('avança no intervalo mesmo com pendências, sem declará-las finalizadas', () => {
    const games = season();
    Object.assign(games.find(game => game.rodada === 27)!, { status: 'TIMED', dataHoraUtc: '2026-10-01T19:00:00Z' });
    const result = competitionReference(games, now);
    expect(result).toMatchObject({ rodadaReferencia: 28, ultimaRodadaConcluida: 21, proximaRodada: 29 });
    expect(result.partidasPendentes).toHaveLength(1);
    expect(result.partidasPendentes[0]).toMatchObject({ rodada: 27, status: 'TIMED' });
  });
  it('avança após fim do bloco com status desatualizado, mas não confirma conclusão', () => {
    const games = [...block(27, '2026-09-13'), ...block(28, '2026-09-19')];
    games[0].status = 'IN_PLAY';
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 28, ultimaRodadaConcluida: null });
    expect(competitionReference(games, now).partidasPendentes).toHaveLength(10);
  });
  it.each(['POSTPONED', 'SUSPENDED', 'STATUS_DESCONHECIDO'])('não perde o bloco da rodada por status %s', status => {
    const games = [...block(27, '2026-09-13', 10, 'FINISHED'), ...block(28, '2026-09-15', 10, status), ...block(29, '2026-09-22')];
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 28, ultimaRodadaConcluida: 27, proximaRodada: 29 });
  });
  it('rodada totalmente cancelada não é escolhida nem confirmada como concluída', () => {
    expect(competitionReference(block(1, '2026-09-13', 10, 'CANCELLED'), now)).toMatchObject({
      rodadaReferencia: null, ultimaRodadaConcluida: null, jogos: [], partidasPendentes: [],
    });
  });
  it('não regride ao percorrer o relógio com atrasado e antecipado na temporada', () => {
    const games = season();
    Object.assign(games[0], { status: 'TIMED', dataHoraUtc: '2026-09-23T19:00:00Z' });
    Object.assign(games.find(game => game.rodada === 32)!, { status: 'IN_PLAY', dataHoraUtc: '2026-09-17T19:00:00Z' });
    let previous = 0;
    for (let day = 14; day <= 30; day++) {
      const reference = competitionReference(games, new Date(`2026-09-${day}T15:00:00Z`)).rodadaReferencia!;
      expect(reference).toBeGreaterThanOrEqual(previous);
      previous = reference;
    }
  });
  it('protege o último jogo TIMED durante a madrugada e só avança no fim do bloco', () => {
    const games = [...block(27, '2026-09-13'), ...block(28, '2026-09-19')];
    games[0].dataHoraUtc = '2026-09-13T23:59:00Z';
    expect(competitionReference(games, new Date('2026-09-14T00:00:00Z')).rodadaReferencia).toBe(27);
    expect(competitionReference(games, new Date('2026-09-14T06:00:00Z')).rodadaReferencia).toBe(28);
  });
  it('rodada encerrada hoje avança sem esperar mudança de dia', () => {
    const games = [...block(27, '2026-09-15', 10, 'FINISHED'), ...block(28, '2026-09-19')];
    expect(competitionReference(games, new Date('2026-09-15T23:00:00Z'))).toMatchObject({ rodadaReferencia: 28, ultimaRodadaConcluida: 27 });
  });
  it.each([9, 12, 18])('deduz dimensão da própria fase: %i jogos por rodada', count => {
    const games = [...block(7, '2026-09-13', count, 'FINISHED'), ...block(8, '2026-09-19', count), ...block(9, '2026-09-26', count)];
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 8, ultimaRodadaConcluida: 7, proximaRodada: 9 });
  });
  it('agrupa fase + rodada e reinicia números sem misturar jogos ou conclusão', () => {
    const games = [...block(8, '2026-09-01', 18, 'FINISHED', 'LEAGUE_STAGE'), ...block(1, '2026-09-19', 8, 'TIMED', 'LAST_16'),
      ...block(2, '2026-09-26', 8, 'TIMED', 'LAST_16')];
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 1, faseReferencia: 'LAST_16', ultimaRodadaConcluida: 8,
      faseUltimaRodadaConcluida: 'LEAGUE_STAGE', proximaRodada: 2, faseProximaRodada: 'LAST_16' });
    expect(competitionReference(games, now).jogos).toHaveLength(8);
  });
  it('mesmo número em fases diferentes não funde grupos', () => {
    const games = [...block(1, '2026-09-01', 8, 'FINISHED', 'QUALIFICATION'), ...block(1, '2026-09-19', 18, 'TIMED', 'LEAGUE_STAGE')];
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 1, faseReferencia: 'LEAGUE_STAGE', faseUltimaRodadaConcluida: 'QUALIFICATION' });
    expect(competitionReference(games, now).jogos).toHaveLength(18);
  });
  it('suporta etapa coletiva sem número de rodada', () => {
    const games = [...block(8, '2026-09-01', 18, 'FINISHED', 'LEAGUE_STAGE'), ...block(null, '2026-09-19', 8, 'TIMED', 'LAST_16')];
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: null, faseReferencia: 'LAST_16' });
    expect(competitionReference(games, now).jogos).toHaveLength(8);
  });
  it('última rodada finalizada permanece referência, sem inventar próxima', () => {
    const games = block(46, '2026-09-13', 12, 'AWARDED');
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 46, ultimaRodadaConcluida: 46, proximaRodada: null });
  });
  it('um registro isolado de rodada futura não vira bloco nem conclusão', () => {
    const games = [...season(), ...block(33, '2026-09-13', 1, 'FINISHED')];
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 28, ultimaRodadaConcluida: 27 });
  });
  it('não declara concluída rodada com cobertura inferior à observada na fase', () => {
    const games = [...block(27, '2026-09-13', 6, 'FINISHED'), ...block(28, '2026-09-19', 10)];
    expect(competitionReference(games, now)).toMatchObject({ rodadaReferencia: 28, ultimaRodadaConcluida: null });
  });
  it('não usa uma data isolada para desempatar blocos fragmentados sem maioria', () => {
    const games = [...block(27, '2026-08-01', 5), ...block(27, '2026-09-01', 5).map(game => ({ ...game, id: game.id + 5 }))];
    expect(competitionReference(games, now).rodadaReferencia).toBeNull();
  });
  it('uma remarcação que fragmenta o bloco não faz pular a rodada sucessora', () => {
    const games = [...block(27, '2026-09-13', 10, 'FINISHED'), ...block(28, '2026-09-19', 6),
      ...block(28, '2026-10-19', 4).map(game => ({ ...game, id: game.id + 6 })), ...block(29, '2026-09-26')];
    expect(competitionReference(games, now).rodadaReferencia).toBe(28);
    games.find(game => game.rodada === 28)!.dataHoraUtc = '2026-10-19T19:00:00Z';
    expect(competitionReference(games, now).rodadaReferencia).toBe(28);
    expect(competitionReference(games, now).proximaRodada).toBe(29);
    // Also preserve the first known round when prior rounds were not imported.
    expect(competitionReference(games.filter(game => game.rodada !== 27), now).rodadaReferencia).toBe(28);
  });
  it('é determinística independentemente da ordem de entrada e não altera as partidas', () => {
    const games = season();
    const original = JSON.stringify(games);
    expect(competitionReference([...games].reverse(), now)).toEqual(competitionReference(games, now));
    expect(JSON.stringify(games)).toBe(original);
  });
  it('sem evidência coletiva não escolhe partida única nem final futuro isolado', () => {
    expect(competitionReference(block(1, '2026-09-13', 1, 'IN_PLAY'), now).rodadaReferencia).toBeNull();
    expect(competitionReference([], now)).toMatchObject({ rodadaReferencia: null, faseReferencia: null, jogos: [], partidasPendentes: [] });
  });
});
