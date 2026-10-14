import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { LotesInscricaoService } from '../ligas-competicoes/lotes-inscricao.service';
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
  let enrollmentBatches: { criarFree: jest.Mock; consultarResultadoFreeConfirmado: jest.Mock };
  let lastEnrollment: { response: Record<string, unknown>; ids: number[] } | null;
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
    lastEnrollment = null;
    enrollmentBatches = {
      criarFree: jest.fn().mockImplementation(async (competicaoId: number, _usuarioId: number, dto: { timesCartolaIds: number[] }) => {
        const ids = [...dto.timesCartolaIds].sort((a, b) => a - b);
        const response = {
          loteId: 500, competicaoId, quantidade: ids.length, tipoAcesso: 'FREE', moeda: 'BRL',
          valorUnitario: '0.00', valorTotal: '0.00', movimentacaoDebitoId: null,
          saldoDisponivelAposOperacao: null,
          inscricoes: ids.map((timeIdCartola, index) => ({ id: index + 1, timeIdCartola, statusInscricao: 'ATIVA' })),
        };
        lastEnrollment = { response, ids };
        return response;
      }),
      consultarResultadoFreeConfirmado: jest.fn().mockImplementation(async () => lastEnrollment && ({
        resposta: lastEnrollment.response,
        competenciaNome: competition().nome,
        times: lastEnrollment.ids.map(timeIdCartola => ({ timeIdCartola, nomeTime: `Time ${timeIdCartola}` })),
      })),
    };
    service = createFreshService();
  });

  const createFreshService = () => new TelegramSelectionService(
    competitions as unknown as TelegramCompetitionsService,
    links as unknown as TelegramLinkService,
    teams as unknown as MeusTimesService,
    inscriptions as unknown as InscricoesCompeticaoService,
    enrollmentBatches as unknown as LotesInscricaoService,
  );

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
    const initialQueries = [
      links.resolveActiveUserId.mock.calls.length,
      competitions.buscarGratuitaElegivel.mock.calls.length,
      teams.listarTimesDoUsuario.mock.calls.length,
      inscriptions.minhas.mock.calls.length,
      competitions.contarParticipantesAtivos.mock.calls.length,
    ];
    const oldData = button(initial, '⬜ Time 1001 (#1001)');
    const selected = await press('54321', oldData);
    expect(selected?.text).toContain('Times selecionados: 1');
    expect(selected?.inlineKeyboard?.flat().some(item => item.text === '✅ Time 1001 (#1001)')).toBe(true);
    expect(selected?.editMessage).toBe(true);
    expect(await press('54321', oldData)).toBeNull();

    const unselected = await press('54321', button(selected!, '✅ Time 1001 (#1001)'));
    expect(unselected?.text).toContain('Times selecionados: 0');
    expect(unselected?.inlineKeyboard?.flat().some(item => item.text.startsWith('✅ Continuar'))).toBe(false);
    expect([
      links.resolveActiveUserId.mock.calls.length,
      competitions.buscarGratuitaElegivel.mock.calls.length,
      teams.listarTimesDoUsuario.mock.calls.length,
      inscriptions.minhas.mock.calls.length,
      competitions.contarParticipantesAtivos.mock.calls.length,
    ]).toEqual(initialQueries);
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
    expect(summary?.inlineKeyboard?.flat().map(item => item.text)).toEqual(['✅ Confirmar inscrição', '↩️ Voltar à seleção', '❌ Cancelar']);
    expect(button(summary!, '✅ Confirmar inscrição').length).toBeLessThanOrEqual(64);
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
    expect(Object.keys(inscriptions)).toEqual(['minhas']);

    const result = await press('54321', button(summary!, '✅ Confirmar inscrição'));
    expect(result?.text).toContain('🏆 Inscrição realizada com sucesso!');
    expect(result?.text).toContain('Competição: POINT FFC - Rodada 42');
    expect(result?.text).toContain('Total: 2 times');
    expect(result?.text).toContain('Valor: R$ 0,00');
    expect(result?.text).toContain('Time 101 (#101)');
    expect(result?.text).toContain('Time 102 (#102)');
    expect(enrollmentBatches.criarFree).toHaveBeenCalledWith(42, 7, {
      timesCartolaIds: [101, 102], valorUnitarioEsperado: '0.00',
    }, expect.stringMatching(/^[A-Za-z0-9_-]{24}$/));
  });

  it('keeps every selected team and the required notice when the summary needs multiple Telegram messages', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue(
      Array.from({ length: 80 }, (_, index) => team(index + 1000, `Equipe Cartola ${index + 1} ${'X'.repeat(50)}`)),
    );
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '☑️ Selecionar todos'));
    const summary = await press('54321', button(selected!, '✅ Continuar (50)'));
    const allText = [summary?.text ?? '', ...(summary?.followUpMessages ?? [])].join('\n');
    expect(summary?.text.length).toBeLessThanOrEqual(3900);
    expect(summary?.followUpMessages?.length).toBeGreaterThan(0);
    expect(allText).toContain('Equipe Cartola 1');
    expect(allText).toContain('Equipe Cartola 50');
    expect(allText).toContain('(#1000)');
    expect(allText).toContain('(#1049)');
    expect(allText).not.toContain('Equipe Cartola 51');
    expect(allText).toContain('Os times foram selecionados, mas nenhuma inscrição foi realizada.');
  });

  it('reuses the persistent idempotency key after an uncertain result and safely recovers duplicate callbacks', async () => {
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 1001 (#1001)'));
    const summary = await press('54321', button(selected!, '✅ Continuar (1)'));
    const confirmData = button(summary!, '✅ Confirmar inscrição');
    const key = confirmData.split(':').at(-1);
    expect(confirmData.length).toBeLessThanOrEqual(64);
    enrollmentBatches.criarFree.mockRejectedValueOnce(new Error('connection lost after commit'));

    const retry = await press('54321', confirmData);
    expect(retry?.text).toContain('A operação pode ter sido concluída');
    const retryData = button(retry!, '✅ Confirmar inscrição');
    expect(retryData.split(':').at(-1)).toBe(key);

    const [first, repeated] = await Promise.all([
      press('54321', retryData),
      press('54321', retryData),
    ]);
    expect(first?.text).toContain('🏆 Inscrição realizada com sucesso!');
    expect(repeated?.text).toContain('🏆 Inscrição realizada com sucesso!');
    expect(enrollmentBatches.criarFree).toHaveBeenCalledTimes(2);
    expect(enrollmentBatches.consultarResultadoFreeConfirmado).toHaveBeenCalledWith(7, key);
  });

  it('recovers a confirmed receipt after session loss without creating another batch', async () => {
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 1001 (#1001)'));
    const summary = await press('54321', button(selected!, '✅ Continuar (1)'));
    enrollmentBatches.consultarResultadoFreeConfirmado.mockRejectedValueOnce(new Error('response lost'));
    const uncertain = await press('54321', button(summary!, '✅ Confirmar inscrição'));
    expect(uncertain?.text).toContain('operação pode ter sido concluída');
    const recoveryCallback = button(uncertain!, '✅ Confirmar inscrição');
    const key = recoveryCallback.split(':').at(-1)!;

    service.clear('54321');
    const recovered = await press('54321', recoveryCallback);
    expect(recovered?.text).toContain('🏆 Inscrição realizada com sucesso!');
    expect(enrollmentBatches.consultarResultadoFreeConfirmado).toHaveBeenLastCalledWith(7, key);
    expect(enrollmentBatches.criarFree).toHaveBeenCalledTimes(1);
  });

  it('recovers after a process restart and scopes the persisted key to the active linked user', async () => {
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 1001 (#1001)'));
    const summary = await press('54321', button(selected!, '✅ Continuar (1)'));
    enrollmentBatches.consultarResultadoFreeConfirmado.mockRejectedValueOnce(new Error('process lost response'));
    const uncertain = await press('54321', button(summary!, '✅ Confirmar inscrição'));
    const recoveryCallback = button(uncertain!, '✅ Confirmar inscrição');
    const key = recoveryCallback.split(':').at(-1)!;

    service = createFreshService();
    const recovered = await press('54321', recoveryCallback);
    expect(recovered?.text).toContain('🏆 Inscrição realizada com sucesso!');
    expect(enrollmentBatches.consultarResultadoFreeConfirmado).toHaveBeenLastCalledWith(7, key);
    expect(enrollmentBatches.criarFree).toHaveBeenCalledTimes(1);

    service = createFreshService();
    links.resolveActiveUserId.mockResolvedValueOnce(8);
    enrollmentBatches.consultarResultadoFreeConfirmado.mockResolvedValueOnce(null);
    const foreign = await press('99999', recoveryCallback);
    expect(foreign?.text).toBe('');
    expect(enrollmentBatches.consultarResultadoFreeConfirmado).toHaveBeenLastCalledWith(8, key);
    expect(enrollmentBatches.criarFree).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed recovery callbacks and requires an active Telegram link', async () => {
    const invalid = await service.handleCallback({
      telegramUserId: '54321', chatId: '54321', messageId: 900,
      data: 'pfc:session12345678:nonce1234:confirm:invalid',
    });
    expect(invalid).toBeNull();
    expect(enrollmentBatches.consultarResultadoFreeConfirmado).not.toHaveBeenCalled();
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();

    links.resolveActiveUserId.mockResolvedValueOnce(null);
    const revoked = await service.handleCallback({
      telegramUserId: '54321', chatId: '54321', messageId: 900,
      data: 'pfc:session12345678:nonce1234:confirm:aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(revoked).toBeNull();
    expect(enrollmentBatches.consultarResultadoFreeConfirmado).not.toHaveBeenCalled();
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('does not enroll until explicit confirmation and blocks competition that became paid', async () => {
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 1001 (#1001)'));
    competitions.buscarGratuitaElegivel.mockResolvedValueOnce(competition({ tipoAcesso: 'PAGO', valorInscricao: 10 }));
    const rejected = await press('54321', button(selected!, '✅ Continuar (1)'));
    expect(rejected?.text).toContain('deixou de estar disponível');
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('rejects the summary and clears selection when ownership or registration eligibility changes', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([team(100), team(101)]);
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 100 (#100)'));
    teams.listarTimesDoUsuario.mockResolvedValue([team(101)]);
    const refreshed = await press('54321', button(selected!, '✅ Continuar (1)'));
    expect(refreshed?.text).toContain('A elegibilidade mudou desde o carregamento');
    expect(refreshed?.text).toContain('Times selecionados: 0');
    expect(refreshed?.text).not.toContain('Resumo da seleção');
    expect(refreshed?.inlineKeyboard?.flat().some(item => item.text.includes('#100'))).toBe(false);
  });

  it('revalidates linked active account and removes the selection if the user is unlinked', async () => {
    const initial = await startTeams();
    links.resolveActiveUserId.mockResolvedValueOnce(null);
    const selected = await press('54321', button(initial, '☑️ Selecionar todos'));
    const response = await press('54321', button(selected!, '✅ Continuar (1)'));
    expect(response?.editMessage).toBe(true);
    expect(response?.text).toContain('vínculo ativo');
    expect(response?.inlineKeyboard).toEqual([]);
  });

  it('stops the journey when the competition is no longer free and eligible', async () => {
    const initial = await startTeams();
    competitions.buscarGratuitaElegivel.mockResolvedValueOnce(null);
    const selected = await press('54321', button(initial, '☑️ Selecionar todos'));
    const response = await press('54321', button(selected!, '✅ Continuar (1)'));
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

  it('uses the loaded snapshot for visual callbacks and revalidates everything only on Continue', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue(Array.from({ length: 10 }, (_, index) => team(index + 100)));
    const initial = await startTeams();
    const baseline = {
      link: links.resolveActiveUserId.mock.calls.length,
      competition: competitions.buscarGratuitaElegivel.mock.calls.length,
      teams: teams.listarTimesDoUsuario.mock.calls.length,
      registrations: inscriptions.minhas.mock.calls.length,
      participants: competitions.contarParticipantesAtivos.mock.calls.length,
    };
    const selectedAll = await press('54321', button(initial, '☑️ Selecionar todos'));
    const nextPage = await press('54321', button(selectedAll!, '➡️ Próxima'));
    const cleared = await press('54321', button(nextPage!, '🗑️ Limpar seleção'));
    expect(links.resolveActiveUserId).toHaveBeenCalledTimes(baseline.link);
    expect(competitions.buscarGratuitaElegivel).toHaveBeenCalledTimes(baseline.competition);
    expect(teams.listarTimesDoUsuario).toHaveBeenCalledTimes(baseline.teams);
    expect(inscriptions.minhas).toHaveBeenCalledTimes(baseline.registrations);
    expect(competitions.contarParticipantesAtivos).toHaveBeenCalledTimes(baseline.participants);

    const selected = await press('54321', button(cleared!, '☑️ Selecionar todos'));
    await press('54321', button(selected!, '✅ Continuar (10)'));
    expect(links.resolveActiveUserId).toHaveBeenCalledTimes(baseline.link + 1);
    expect(competitions.buscarGratuitaElegivel).toHaveBeenCalledTimes(baseline.competition + 1);
    expect(teams.listarTimesDoUsuario).toHaveBeenCalledTimes(baseline.teams + 1);
    expect(inscriptions.minhas).toHaveBeenCalledTimes(baseline.registrations + 1);
    expect(competitions.contarParticipantesAtivos).toHaveBeenCalledTimes(baseline.participants + 1);
  });
});
