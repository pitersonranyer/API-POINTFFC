import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { MeusTimesService } from '../meus-times/meus-times.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramCompetitionsService } from './telegram-competitions.service';
import { TelegramSelectionService } from './telegram-selection.service';

describe('TelegramSelectionService', () => {
  const competition = (id = 42) => ({
    id,
    nome: `POINT FFC - Rodada ${id}`,
    tipoAcesso: 'FREE',
    valorInscricao: 0,
    rodadaInicio: id,
    rodadaFim: id,
    fimInscricao: '2026-10-14T23:59:00.000Z',
    limiteTimesUsuario: 30,
  });
  const team = (timeId = 1001, nome = 'Meu Time') => ({ timeId, nome });
  const registration = (timeIdCartola: number, statusInscricao = 'ATIVA') => ({
    timeIdCartola, statusInscricao,
  });

  let competitions: { listarGratuitasElegiveis: jest.Mock; buscarGratuitaElegivel: jest.Mock };
  let links: { resolveActiveUserId: jest.Mock };
  let teams: { listarTimesDoUsuario: jest.Mock };
  let inscriptions: { minhas: jest.Mock };
  let service: TelegramSelectionService;

  beforeEach(() => {
    competitions = {
      listarGratuitasElegiveis: jest.fn().mockResolvedValue([competition()]),
      buscarGratuitaElegivel: jest.fn().mockImplementation(async id => id === 42 ? competition(id) : null),
    };
    links = { resolveActiveUserId: jest.fn().mockResolvedValue(7) };
    teams = { listarTimesDoUsuario: jest.fn().mockResolvedValue([team()]) };
    inscriptions = { minhas: jest.fn().mockResolvedValue([]) };
    service = new TelegramSelectionService(
      competitions as unknown as TelegramCompetitionsService,
      links as unknown as TelegramLinkService,
      teams as unknown as MeusTimesService,
      inscriptions as unknown as InscricoesCompeticaoService,
    );
  });

  it('lists eligible free competitions and shows names, round, zero price and deadline', async () => {
    const result = await service.start('54321');
    expect(competitions.listarGratuitasElegiveis).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('POINT FFC - Rodada 42');
    expect(result.text).toContain('Rodada: 42');
    expect(result.text).toContain('Valor: R$ 0,00');
    expect(result.text).toContain('Prazo:');
    expect(result.buttons.flat().some(button => button.includes('POINT FFC - Rodada 42'))).toBe(true);
  });

  it('shows competition pagination controls only when those pages exist and returns to the previous page', async () => {
    const items = Array.from({ length: 17 }, (_, index) => competition(100 + index));
    competitions.listarGratuitasElegiveis.mockResolvedValue(items);
    competitions.buscarGratuitaElegivel.mockImplementation(async id => items.find(item => item.id === id) ?? null);

    const first = await service.start('54321');
    expect(first.buttons.flat()).not.toContain('⬅️ Anterior');
    expect(first.buttons.flat()).toContain('➡️ Mais opções');

    const second = await service.handle('54321', '➡️ Mais opções');
    expect(second?.buttons.flat()).toContain('⬅️ Anterior');
    expect(second?.buttons.flat()).toContain('➡️ Mais opções');

    const last = await service.handle('54321', '➡️ Mais opções');
    expect(last?.buttons.flat()).toContain('⬅️ Anterior');
    expect(last?.buttons.flat()).not.toContain('➡️ Mais opções');

    const back = await service.handle('54321', '⬅️ Anterior');
    expect(back?.buttons.flat()).toContain('⬅️ Anterior');
    expect(back?.buttons.flat()).toContain('➡️ Mais opções');
    expect(back?.buttons.flat().some(button => button.includes('#108'))).toBe(true);
    expect(back?.buttons.flat().some(button => button.includes('#116'))).toBe(false);
  });

  it('keeps the selected competition while paging teams in both directions', async () => {
    const userTeams = Array.from({ length: 17 }, (_, index) => team(2000 + index, `Time ${index + 1}`));
    teams.listarTimesDoUsuario.mockResolvedValue(userTeams);
    const competitionButton = '1. POINT FFC - Rodada 42 (R42, #42)';
    await service.start('54321');
    const first = await service.handle('54321', competitionButton);
    expect(first?.buttons.flat()).not.toContain('⬅️ Anterior');
    expect(first?.buttons.flat()).toContain('➡️ Mais opções');

    const second = await service.handle('54321', '➡️ Mais opções');
    expect(second?.text).toContain('POINT FFC - Rodada 42');
    expect(second?.buttons.flat()).toContain('⬅️ Anterior');
    expect(second?.buttons.flat()).toContain('➡️ Mais opções');

    const last = await service.handle('54321', '➡️ Mais opções');
    expect(last?.buttons.flat()).toContain('⬅️ Anterior');
    expect(last?.buttons.flat()).not.toContain('➡️ Mais opções');

    const back = await service.handle('54321', '⬅️ Anterior');
    expect(back?.text).toContain('POINT FFC - Rodada 42');
    expect(back?.buttons.flat()).toContain('9. Time 9 (#2008)');
    expect(back?.buttons.flat()).toContain('🏆 Voltar às competições');
    expect(back?.buttons.flat()).toContain('❌ Cancelar');
    const summary = await service.handle('54321', '9. Time 9 (#2008)');
    expect(summary?.text).toContain('Time: Time 9 (#2008)');
  });

  it('keeps each Telegram user on their own competition page and rejects out-of-range navigation', async () => {
    competitions.listarGratuitasElegiveis.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) => competition(100 + index)),
    );
    await service.start('111');
    await service.start('222');
    const userOneNext = await service.handle('111', '➡️ Mais opções');
    expect(userOneNext?.buttons.flat()).toContain('⬅️ Anterior');

    const userTwoPrevious = await service.handle('222', '⬅️ Anterior');
    expect(userTwoPrevious?.buttons.flat()).not.toContain('⬅️ Anterior');
    expect(userTwoPrevious?.buttons.flat()).toContain('➡️ Mais opções');
    const last = await service.handle('222', '➡️ Mais opções');
    expect(last?.buttons.flat()).toContain('⬅️ Anterior');
    expect(last?.buttons.flat()).not.toContain('➡️ Mais opções');
    const beyondLast = await service.handle('222', '➡️ Mais opções');
    expect(beyondLast?.buttons.flat()).toContain('⬅️ Anterior');
    expect(beyondLast?.buttons.flat()).not.toContain('➡️ Mais opções');
  });

  it('revalidates the selected competition and identifies the user from the active Telegram link', async () => {
    await service.start('54321');
    const selected = await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    expect(competitions.buscarGratuitaElegivel).toHaveBeenCalledWith(42);
    expect(links.resolveActiveUserId).toHaveBeenCalledWith('54321');
    expect(inscriptions.minhas).toHaveBeenCalledWith(42, 7);
    expect(teams.listarTimesDoUsuario).toHaveBeenCalledWith(7);
    expect(selected?.text).toContain('Escolha um dos seus times');
    expect(selected?.buttons.flat().some(button => button.includes('Meu Time') && button.includes('#1001'))).toBe(true);
  });

  it('asks an unlinked, blocked or inactive user to connect without consulting teams', async () => {
    for (const status of [null, null, null]) {
      const isolated = new TelegramSelectionService(
        competitions as unknown as TelegramCompetitionsService,
        { resolveActiveUserId: jest.fn().mockResolvedValue(status) } as unknown as TelegramLinkService,
        teams as unknown as MeusTimesService,
        inscriptions as unknown as InscricoesCompeticaoService,
      );
      await isolated.start('54321');
      const result = await isolated.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
      expect(result?.text).toContain('conecte sua conta POINT FFC');
      expect(result?.text).toContain('https://pointffc.com.br/conectar-telegram/');
    }
    expect(teams.listarTimesDoUsuario).not.toHaveBeenCalled();
  });

  it('does not confuse an account lookup failure with a missing link', async () => {
    links.resolveActiveUserId.mockRejectedValueOnce(new Error('database failure'));
    await service.start('54321');
    const result = await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    expect(result?.text).toContain('Não foi possível verificar seu vínculo');
    expect(result?.text).not.toContain('conecte sua conta');
  });

  it('excludes teams already registered, including canceled registrations', async () => {
    inscriptions.minhas.mockResolvedValue([registration(1001, 'CANCELADA')]);
    await service.start('54321');
    const result = await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    expect(result?.text).toContain('Não há times disponíveis');
    expect(result?.buttons.flat()).toContain('🏆 Voltar às competições');
  });

  it('enforces the user limit before offering teams', async () => {
    inscriptions.minhas.mockResolvedValue(Array.from({ length: 30 }, (_, index) => registration(2000 + index)));
    await service.start('54321');
    const result = await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    expect(result?.text).toContain('limite de 30 time(s)');
    expect(teams.listarTimesDoUsuario).not.toHaveBeenCalled();
  });

  it('shows a preview for one owned team and explicitly says no inscription was made', async () => {
    await service.start('54321');
    await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    const result = await service.handle('54321', '1. Meu Time (#1001)');
    expect(result?.text).toContain('Competição: POINT FFC - Rodada 42');
    expect(result?.text).toContain('Time: Meu Time (#1001)');
    expect(result?.text).toContain('Valor: R$ 0,00');
    expect(result?.text).toContain('Seu time foi selecionado. A inscrição ainda não foi realizada.');
    expect(result?.buttons.flat()).toEqual(['🔄 Escolher outro time', '🏆 Voltar às competições', '❌ Cancelar']);
    expect(Object.keys(inscriptions)).toEqual(['minhas']);
  });

  it('rejects arbitrary team text and does not advance the selection', async () => {
    await service.start('54321');
    await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    const result = await service.handle('54321', '99999999');
    expect(result?.text).toContain('Escolha um dos seus times');
    expect(result?.text).not.toContain('Resumo da seleção');
  });

  it('does not advance the same team choice again after showing the summary', async () => {
    await service.start('54321');
    await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    await service.handle('54321', '1. Meu Time (#1001)');
    const repeated = await service.handle('54321', '1. Meu Time (#1001)');
    expect(repeated?.text).toContain('A inscrição ainda não foi realizada');
    expect(repeated?.text).not.toContain('Time: Meu Time');
  });

  it('serializes simultaneous team selections for the same Telegram user', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([team(1001, 'Time A'), team(1002, 'Time B')]);
    await service.start('54321');
    await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');

    const [first, second] = await Promise.all([
      service.handle('54321', '1. Time A (#1001)'),
      service.handle('54321', '2. Time B (#1002)'),
    ]);
    expect(first?.text).toContain('Time: Time A (#1001)');
    expect(second?.text).toContain('Seu time foi selecionado. A inscrição ainda não foi realizada.');
    expect(second?.text).not.toContain('Time: Time B');
  });

  it('expires sessions and supports cancellation and returning to competitions', async () => {
    jest.useFakeTimers();
    try {
      competitions.listarGratuitasElegiveis.mockResolvedValue(
        Array.from({ length: 9 }, (_, index) => competition(100 + index)),
      );
      const first = await service.start('54321');
      expect(first.buttons.length).toBeGreaterThan(0);
      await service.handle('54321', '➡️ Mais opções');
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      const expired = await service.handle('54321', '⬅️ Anterior');
      expect(expired?.text).toContain('Sua seleção expirou');

      await service.start('54321');
      const cancelled = await service.handle('54321', '❌ Cancelar');
      expect(cancelled?.text).toContain('Jornada cancelada');
      expect((await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)'))?.text).toContain('expirou ou foi reiniciada');
    } finally {
      jest.useRealTimers();
    }
  });

  it('isolates session state between Telegram users', async () => {
    await service.start('111');
    await service.start('222');
    await service.handle('111', '1. POINT FFC - Rodada 42 (R42, #42)');
    expect(teams.listarTimesDoUsuario).toHaveBeenCalledTimes(1);
    const other = await service.handle('222', 'texto inválido');
    expect(other?.text).toContain('Escolha uma das competições');
    expect(teams.listarTimesDoUsuario).toHaveBeenCalledTimes(1);
  });

  it('treats an old selection button after process restart as expired', async () => {
    const oldProcess = service;
    await oldProcess.start('54321');
    const restartedProcess = new TelegramSelectionService(
      competitions as unknown as TelegramCompetitionsService,
      links as unknown as TelegramLinkService,
      teams as unknown as MeusTimesService,
      inscriptions as unknown as InscricoesCompeticaoService,
    );
    const result = await restartedProcess.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    expect(result?.text).toContain('expirou ou foi reiniciada');
    expect(links.resolveActiveUserId).not.toHaveBeenCalled();
  });

  it('handles competition disappearance and query failures without selecting stale data', async () => {
    await service.start('54321');
    competitions.buscarGratuitaElegivel.mockResolvedValueOnce(null);
    const gone = await service.handle('54321', '1. POINT FFC - Rodada 42 (R42, #42)');
    expect(gone?.text).toContain('não está mais disponível');

    competitions.listarGratuitasElegiveis.mockRejectedValueOnce(new Error('private diagnostic'));
    const failed = await service.start('54321');
    expect(failed.text).toContain('Não foi possível consultar');
    expect(failed.text).not.toContain('private diagnostic');
  });
});
