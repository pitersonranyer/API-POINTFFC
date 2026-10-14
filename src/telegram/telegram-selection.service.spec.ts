import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { MeusTimesService } from '../meus-times/meus-times.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramCompetitionsService } from './telegram-competitions.service';
import { TelegramSelectionResponse, TelegramSelectionService } from './telegram-selection.service';

describe('TelegramSelectionService', () => {
  const competition = (overrides: Record<string, unknown> = {}) => ({
    id: 42,
    nome: 'POINT FFC - Rodada 42',
    tipoAcesso: 'FREE',
    valorInscricao: 0,
    rodadaInicio: 42,
    rodadaFim: 42,
    fimInscricao: '2026-10-14T23:59:00.000Z',
    limiteTimesUsuario: null,
    limiteParticipantes: null,
    ...overrides,
  });
  const team = (timeId: number, nome = `Time ${timeId}`) => ({ timeId, nome });
  const registration = (timeIdCartola: number, statusInscricao = 'ATIVA') => ({ timeIdCartola, statusInscricao });

  let competitions: {
    listarGratuitasElegiveis: jest.Mock;
    buscarGratuitaElegivel: jest.Mock;
    contarParticipantesAtivos: jest.Mock;
  };
  let links: { resolveActiveUserId: jest.Mock };
  let teams: { listarTimesDoUsuario: jest.Mock };
  let inscriptions: { minhas: jest.Mock };
  let service: TelegramSelectionService;

  beforeEach(() => {
    competitions = {
      listarGratuitasElegiveis: jest.fn().mockResolvedValue([competition()]),
      buscarGratuitaElegivel: jest.fn().mockResolvedValue(competition()),
      contarParticipantesAtivos: jest.fn().mockResolvedValue(0),
    };
    links = { resolveActiveUserId: jest.fn().mockResolvedValue(7) };
    teams = { listarTimesDoUsuario: jest.fn().mockResolvedValue([team(1001)]) };
    inscriptions = { minhas: jest.fn().mockResolvedValue([]) };
    service = new TelegramSelectionService(
      competitions as unknown as TelegramCompetitionsService,
      links as unknown as TelegramLinkService,
      teams as unknown as MeusTimesService,
      inscriptions as unknown as InscricoesCompeticaoService,
    );
  });

  const startTeams = async (telegramUserId = '54321'): Promise<TelegramSelectionResponse> => {
    const competitionsPage = await service.start(telegramUserId);
    const selected = await service.handle(telegramUserId, competitionsPage.buttons[0][0]);
    if (!selected?.inlineKeyboard || !selected.sessionToken) throw new Error('expected inline team keyboard');
    service.attachInlineMessage(telegramUserId, selected.sessionToken, telegramUserId, 900);
    return selected;
  };

  const button = (response: TelegramSelectionResponse, text: string): string => {
    const result = response.inlineKeyboard?.flat().find(item => item.text === text);
    if (!result) throw new Error(`missing button: ${text}`);
    return result.callback_data;
  };

  const press = (telegramUserId: string, data: string, messageId = 900) => service.handleCallback({
    telegramUserId,
    chatId: telegramUserId,
    messageId,
    data,
  });

  it('lists eligible free competitions and preserves the public competition service contract', async () => {
    const result = await service.start('54321');
    expect(competitions.listarGratuitasElegiveis).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('POINT FFC - Rodada 42');
    expect(result.text).toContain('Rodada: 42');
    expect(result.text).toContain('Valor: R$ 0,00');
    expect(result.text).toContain('Prazo:');
  });

  it('marks and unmarks an individual team and rejects an outdated callback nonce', async () => {
    const initial = await startTeams();
    const oldData = button(initial, '⬜ Time 1001 (#1001)');
    const selected = await press('54321', oldData);
    expect(selected?.text).toContain('Times selecionados: 1');
    expect(selected?.inlineKeyboard?.flat().some(item => item.text === '✅ Time 1001 (#1001)')).toBe(true);
    expect(selected?.editMessage).toBe(true);
    expect(await press('54321', oldData)).toBeNull();

    const unselected = await press('54321', button(selected!, '✅ Time 1001 (#1001)'));
    expect(unselected?.text).toContain('Times selecionados: 0');
    expect(unselected?.inlineKeyboard?.flat().some(item => item.text.startsWith('✅ Continuar'))).toBe(false);
  });

  it('selects all eligible teams across pages, changes the button label, and clears all selections', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue(Array.from({ length: 11 }, (_, index) => team(index + 100)));
    const initial = await startTeams();
    expect(initial.inlineKeyboard?.flat().some(item => item.text === '➡️ Próxima')).toBe(true);
    expect(initial.inlineKeyboard?.flat().every(item => Buffer.byteLength(item.callback_data, 'utf8') <= 64)).toBe(true);

    const selectedAll = await press('54321', button(initial, '☑️ Selecionar todos'));
    expect(selectedAll?.text).toContain('Times selecionados: 11');
    expect(selectedAll?.inlineKeyboard?.flat()).toContainEqual(expect.objectContaining({ text: '⬜ Desmarcar todos' }));
    const cleared = await press('54321', button(selectedAll!, '⬜ Desmarcar todos'));
    expect(cleared?.text).toContain('Times selecionados: 0');
    expect(cleared?.inlineKeyboard?.flat().some(item => item.text === '✅ Continuar (11)')).toBe(false);
  });

  it('clears a partial selection with Limpar seleção', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([team(100), team(101)]);
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 100 (#100)'));
    const cleared = await press('54321', button(selected!, '🗑️ Limpar seleção'));
    expect(cleared?.text).toContain('Times selecionados: 0');
    expect(cleared?.inlineKeyboard?.flat().some(item => item.text.startsWith('✅ Continuar'))).toBe(false);
  });

  it('caps select all by the remaining per-user and competition capacity', async () => {
    competitions.buscarGratuitaElegivel.mockResolvedValue(competition({ limiteTimesUsuario: 5, limiteParticipantes: 7 }));
    competitions.contarParticipantesAtivos.mockResolvedValue(5);
    inscriptions.minhas.mockResolvedValue([registration(990, 'ATIVA'), registration(991, 'ATIVA')]);
    teams.listarTimesDoUsuario.mockResolvedValue(Array.from({ length: 10 }, (_, index) => team(index + 100)));
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '☑️ Selecionar todos'));
    expect(selected?.text).toContain('Times selecionados: 2');
    expect(selected?.text).toContain('Selecionamos 2 times. O limite disponível para esta competição é de 2.');
    expect(selected?.inlineKeyboard?.flat().some(item => item.text === '✅ Continuar (2)')).toBe(true);
  });

  it('preserves selections and the global counter across pages in both directions', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue(Array.from({ length: 17 }, (_, index) => team(index + 100)));
    const first = await startTeams();
    const selected = await press('54321', button(first, '⬜ Time 100 (#100)'));
    expect(selected?.text).toContain('Times selecionados: 1');
    const second = await press('54321', button(selected!, '➡️ Próxima'));
    expect(second?.text).toContain('Times selecionados: 1');
    expect(second?.text).toContain('Página 2 de 3');
    expect(second?.inlineKeyboard?.flat().some(item => item.text === '⬅️ Anterior')).toBe(true);
    const last = await press('54321', button(second!, '➡️ Próxima'));
    expect(last?.text).toContain('Página 3 de 3');
    expect(last?.inlineKeyboard?.flat().some(item => item.text === '➡️ Próxima')).toBe(false);
    const backToSecond = await press('54321', button(last!, '⬅️ Anterior'));
    expect(backToSecond?.text).toContain('Times selecionados: 1');
    expect(backToSecond?.text).toContain('Página 2 de 3');
    const previous = await press('54321', button(backToSecond!, '⬅️ Anterior'));
    expect(previous?.text).toContain('Times selecionados: 1');
    expect(previous?.inlineKeyboard?.flat().some(item => item.text === '✅ Time 100 (#100)')).toBe(true);
    expect(previous?.inlineKeyboard?.flat().some(item => item.text === '➡️ Próxima')).toBe(true);
  });

  it('shows the selected competition and all selected team names and IDs in the summary without enrolling', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([team(101, 'Trovão'), team(102, 'Falcão')]);
    const initial = await startTeams();
    const one = await press('54321', button(initial, '⬜ Falcão (#102)'));
    const two = await press('54321', button(one!, '⬜ Trovão (#101)'));
    const summary = await press('54321', button(two!, '✅ Continuar (2)'));
    expect(summary?.text).toContain('Resumo da seleção');
    expect(summary?.text).toContain('Competição: POINT FFC - Rodada 42');
    expect(summary?.text).toContain('Rodada: 42');
    expect(summary?.text).toContain('Times selecionados: 2');
    expect(summary?.text).toContain('Valor total: R$ 0,00');
    expect(summary?.text).toContain('Trovão (#101)');
    expect(summary?.text).toContain('Falcão (#102)');
    expect(summary!.text.indexOf('Trovão (#101)')).toBeLessThan(summary!.text.indexOf('Falcão (#102)'));
    expect(summary?.text).toContain('Os times foram selecionados, mas nenhuma inscrição foi realizada.');
    expect(summary?.inlineKeyboard?.flat().map(item => item.text)).toEqual(['🔄 Alterar seleção', '❌ Cancelar']);
    expect(Object.keys(inscriptions)).toEqual(['minhas']);
  });

  it('keeps every selected team and the required notice when the summary needs multiple Telegram messages', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue(
      Array.from({ length: 80 }, (_, index) => team(index + 1000, `Equipe Cartola ${index + 1} ${'X'.repeat(50)}`)),
    );
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '☑️ Selecionar todos'));
    const summary = await press('54321', button(selected!, '✅ Continuar (80)'));
    const allText = [summary?.text ?? '', ...(summary?.followUpMessages ?? [])].join('\n');
    expect(summary?.text.length).toBeLessThanOrEqual(3900);
    expect(summary?.followUpMessages?.length).toBeGreaterThan(0);
    expect(allText).toContain('Equipe Cartola 1');
    expect(allText).toContain('Equipe Cartola 80');
    expect(allText).toContain('(#1000)');
    expect(allText).toContain('(#1079)');
    expect(allText).toContain('Os times foram selecionados, mas nenhuma inscrição foi realizada.');
  });

  it('clears selections when ownership or registration eligibility changes during the journey', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([team(100), team(101)]);
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 100 (#100)'));
    teams.listarTimesDoUsuario.mockResolvedValue([team(101)]);
    const refreshed = await press('54321', button(selected!, '⬜ Time 101 (#101)'));
    expect(refreshed?.text).toContain('Alguns times foram removidos da seleção porque sua elegibilidade mudou.');
    expect(refreshed?.text).toContain('Times selecionados: 1');
    expect(refreshed?.inlineKeyboard?.flat().some(item => item.text.includes('#100'))).toBe(false);
  });

  it('revalidates linked active account and removes the selection if the user is unlinked', async () => {
    const initial = await startTeams();
    links.resolveActiveUserId.mockResolvedValueOnce(null);
    const response = await press('54321', button(initial, '☑️ Selecionar todos'));
    expect(response?.editMessage).toBe(true);
    expect(response?.text).toContain('vínculo ativo');
    expect(response?.inlineKeyboard).toEqual([]);
  });

  it('stops the journey when the competition is no longer free and eligible', async () => {
    const initial = await startTeams();
    competitions.buscarGratuitaElegivel.mockResolvedValueOnce(null);
    const response = await press('54321', button(initial, '☑️ Selecionar todos'));
    expect(response?.text).toContain('deixou de estar disponível');
    expect(response?.inlineKeyboard).toEqual([]);
  });

  it('does not display or select a team that already has a registration', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([team(100), team(101)]);
    inscriptions.minhas.mockResolvedValue([registration(100, 'CANCELADA')]);
    const initial = await startTeams();
    expect(initial.inlineKeyboard?.flat().some(item => item.text.includes('#100'))).toBe(false);
    const selected = await press('54321', button(initial, '☑️ Selecionar todos'));
    expect(selected?.text).toContain('Times selecionados: 1');
    expect(selected?.inlineKeyboard?.flat().some(item => item.text.includes('#100'))).toBe(false);
  });

  it('rejects callbacks from another user or a different message', async () => {
    const initial = await startTeams();
    const data = button(initial, '☑️ Selecionar todos');
    const otherCompetitions = await service.start('99999');
    const other = await service.handle('99999', otherCompetitions.buttons[0][0]);
    service.attachInlineMessage('99999', other!.sessionToken!, '99999', 901);
    expect(await press('99999', data, 901)).toBeNull();
    expect(await press('54321', data, 901)).toBeNull();
    const otherSelection = await press('99999', button(other!, '☑️ Selecionar todos'), 901);
    expect(otherSelection?.text).toContain('Times selecionados: 1');
  });

  it('expires the inline session after ten minutes and invalidates the old callback', async () => {
    jest.useFakeTimers();
    try {
      const initial = await startTeams();
      const data = button(initial, '☑️ Selecionar todos');
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      const expired = await press('54321', data);
      expect(expired?.text).toContain('Sua seleção expirou');
      expect(expired?.inlineKeyboard).toEqual([]);
      expect(await press('54321', data)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the existing limit and team ownership checks', async () => {
    competitions.buscarGratuitaElegivel.mockResolvedValue(competition({ limiteTimesUsuario: 1 }));
    inscriptions.minhas.mockResolvedValue([registration(990)]);
    teams.listarTimesDoUsuario.mockResolvedValue([team(1001)]);
    const initial = await startTeams();
    expect(initial.text).toContain('Não há times elegíveis disponíveis');
    expect(initial.inlineKeyboard?.flat().some(item => item.text.startsWith('✅ Continuar'))).toBe(false);
    expect(teams.listarTimesDoUsuario).toHaveBeenCalledWith(7);
  });

  it('revalidates competition, link, owned teams, and active participant capacity before every callback', async () => {
    const initial = await startTeams();
    await press('54321', button(initial, '☑️ Selecionar todos'));
    expect(links.resolveActiveUserId).toHaveBeenCalledTimes(2);
    expect(competitions.buscarGratuitaElegivel).toHaveBeenCalledTimes(3);
    expect(teams.listarTimesDoUsuario).toHaveBeenCalledTimes(2);
    expect(competitions.contarParticipantesAtivos).toHaveBeenCalledWith(42);
  });
});
