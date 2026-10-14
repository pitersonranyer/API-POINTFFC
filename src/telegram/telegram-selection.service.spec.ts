import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { LotesInscricaoService } from '../ligas-competicoes/lotes-inscricao.service';
import { MeusTimesService } from '../meus-times/meus-times.service';
import { CartolaService } from '../cartola/cartola.service';
import { NotFoundException } from '@nestjs/common';
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
  let teams: { listarTimesDoUsuario: jest.Mock; adicionarTime: jest.Mock; adicionarTimesEmLote: jest.Mock;
    buscarTimeDoUsuario: jest.Mock; consultarStatusAssociacaoTimes: jest.Mock };
  let cartola: { getTeamById: jest.Mock };
  let inscriptions: { minhas: jest.Mock; minhasDoUsuario: jest.Mock };
  let enrollmentBatches: { criarFree: jest.Mock; consultarResultadoFreeConfirmado: jest.Mock };
  let lastEnrollment: { response: Record<string, unknown>; ids: number[] } | null;
  let associations: Map<number, number>;
  let service: TelegramSelectionService;

  beforeEach(() => {
    competitions = {
      listarGratuitasElegiveis: jest.fn().mockResolvedValue([competition()]),
      buscarGratuitaElegivel: jest.fn().mockResolvedValue(competition()),
      contarParticipantesAtivos: jest.fn().mockResolvedValue(0),
    };
    links = { resolveActiveUserId: jest.fn().mockResolvedValue(7) };
    associations = new Map([[1001, 7]]);
    teams = {
      listarTimesDoUsuario: jest.fn().mockResolvedValue([team(1001)]),
      adicionarTime: jest.fn().mockImplementation(async (usuarioId: number, dto: { timeId: number }) => {
        const owner = associations.get(dto.timeId);
        if (owner !== undefined) return { status: 'ja_existente', timeId: dto.timeId };
        associations.set(dto.timeId, usuarioId);
        return { status: 'adicionado', timeId: dto.timeId };
      }),
      adicionarTimesEmLote: jest.fn().mockImplementation(async (usuarioId: number, times: Array<{ timeId: number }>) => {
        const result = { solicitados: times.length, adicionados: 0, jaExistentes: 0, falhas: [] as Array<{ timeId: number | null; motivo: 'dados_invalidos' | 'erro_persistencia' }>,
          timesAdicionados: [] as number[], timesJaExistentes: [] as number[] };
        for (const item of times) {
          const added = await teams.adicionarTime(usuarioId, item);
          if (added.status === 'adicionado') { result.adicionados += 1; result.timesAdicionados.push(item.timeId); }
          else { result.jaExistentes += 1; result.timesJaExistentes.push(item.timeId); }
        }
        return result;
      }),
      buscarTimeDoUsuario: jest.fn().mockResolvedValue(null),
      consultarStatusAssociacaoTimes: jest.fn().mockImplementation(async (usuarioId: number, ids: number[]) => ids.map(timeId => {
        const owner = associations.get(timeId);
        return { timeId, status: owner === undefined ? 'disponivel' : owner === usuarioId ? 'proprio' : 'outro' };
      })),
    };
    cartola = { getTeamById: jest.fn().mockImplementation(async (timeId: number) => ({ value: { time: {
      time_id: timeId, nome: timeId === 13933388 ? 'Real Prime CFC' : `Time ${timeId}`,
      nome_cartola: 'Cartoleiro', url_escudo_png: 'https://cartola.example/escudo.png',
    } } })) };
    inscriptions = { minhas: jest.fn().mockResolvedValue([]), minhasDoUsuario: jest.fn().mockResolvedValue([]) };
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
    cartola as unknown as CartolaService,
  );

  const startTeams = async (telegramUserId = '54321'): Promise<TelegramSelectionResponse> => {
    const competitionsPage = await service.start(telegramUserId);
    const selected = await service.handle(telegramUserId, competitionsPage.buttons[0][0]);
    if (!selected?.inlineKeyboard || !selected.sessionToken) throw new Error('expected inline team keyboard');
    service.attachInlineMessage(telegramUserId, selected.sessionToken, telegramUserId, 900);
    return selected;
  };

  const startRegistrationPrompt = async (telegramUserId = '54321'): Promise<TelegramSelectionResponse> => {
    const list = await startTeams(telegramUserId);
    const addLabel = list.text.includes('Você ainda não possui times') ? '➕ Cadastrar time' : '➕ Adicionar outro time';
    const response = await press(telegramUserId, button(list, addLabel));
    if (!response?.inlineKeyboard) throw new Error('expected team registration prompt');
    return response;
  };

  const startBulkRegistrationPrompt = async (telegramUserId = '54321'): Promise<TelegramSelectionResponse> => {
    const list = await startTeams(telegramUserId);
    const response = await press(telegramUserId, button(list, '📋 Cadastrar vários times'));
    if (!response?.inlineKeyboard) throw new Error('expected bulk team registration prompt');
    return response;
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
    expect(result.inlineKeyboard?.[0][0].callback_data).toMatch(/select-competition:/);
    expect(result.buttons.flat()).toEqual(expect.arrayContaining(['1. POINT FFC - Rodada 42 (R42, #42)']));
  });

  it('selects a competition through its inline button and keeps the same message context', async () => {
    const page = await service.start('54321');
    service.attachInlineMessage('54321', page.sessionToken!, '54321', 900);
    const selected = await press('54321', button(page, '1. POINT FFC - Rodada 42 (R42)'));
    expect(selected?.editMessage).toBe(true);
    expect(selected?.text).toContain('Escolha seus times');
    expect(competitions.buscarGratuitaElegivel).toHaveBeenCalledWith(42);
  });

  it('offers first-team registration when the linked account has no teams', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([]);
    const response = await startTeams();
    expect(response.text).toContain('Você ainda não possui times cadastrados no POINT FFC');
    expect(response.inlineKeyboard?.flat().map(item => item.text)).toEqual(['➕ Cadastrar time', '📋 Cadastrar vários times', '🏠 Menu principal']);
  });

  it('offers adding another team without removing the current team-selection controls', async () => {
    const response = await startTeams();
    const labels = response.inlineKeyboard?.flat().map(item => item.text) ?? [];
    expect(labels).toContain('➕ Adicionar outro time');
    expect(labels).toContain('📋 Cadastrar vários times');
    expect(labels).toContain('☑️ Selecionar todos');
    expect(labels).toContain('🏠 Menu principal');
  });

  it.each(['1002\n1003', '1002,1003', '1002 1003', '1002;1003'])('accepts bulk IDs separated by supported delimiter %s', async input => {
    const prompt = await startBulkRegistrationPrompt();
    expect(prompt.text).toContain('Máximo: 30 IDs por envio.');
    const preview = await service.handle('54321', input);
    expect(preview?.text).toContain('✅ Times disponíveis: 2');
    expect(preview?.text).toContain('Time 1002 — #1002');
    expect(preview?.text).toContain('Time 1003 — #1003');
    expect(cartola.getTeamById).toHaveBeenCalledTimes(2);
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
    expect(preview?.inlineKeyboard?.flat().map(item => item.text)).toContain('✅ Confirmar cadastro');
  });

  it('offers bulk registration both when the profile has no teams and alongside single-team addition', async () => {
    teams.listarTimesDoUsuario.mockResolvedValue([]);
    const empty = await startTeams();
    expect(empty.inlineKeyboard?.flat().map(item => item.text)).toContain('📋 Cadastrar vários times');

    await service.clear('54321');
    teams.listarTimesDoUsuario.mockResolvedValue([team(1001)]);
    const existing = await startTeams();
    expect(existing.inlineKeyboard?.flat().map(item => item.text)).toEqual(expect.arrayContaining([
      '➕ Adicionar outro time', '📋 Cadastrar vários times',
    ]));
  });

  it('removes repeated IDs from a bulk message before querying Cartola', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002, 1002;1003\n1002');
    expect(preview?.text).toContain('✅ Times disponíveis: 2');
    expect(cartola.getTeamById).toHaveBeenCalledTimes(2);
    expect(teams.consultarStatusAssociacaoTimes).toHaveBeenLastCalledWith(7, [1002, 1003]);
  });

  it('rejects a malformed list as a whole and does not consult or persist any team', async () => {
    await startBulkRegistrationPrompt();
    const response = await service.handle('54321', '1002, time-1003');
    expect(response?.text).toContain('somente IDs numéricos');
    expect(cartola.getTeamById).not.toHaveBeenCalled();
    expect(teams.consultarStatusAssociacaoTimes).not.toHaveBeenCalled();
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
  });

  it('rejects more than 30 distinct IDs instead of silently truncating the request', async () => {
    await startBulkRegistrationPrompt();
    const response = await service.handle('54321', Array.from({ length: 31 }, (_, index) => String(2000 + index)).join(','));
    expect(response?.text).toContain('mais de 30 IDs distintos');
    expect(response?.text).toContain('nenhum ID foi consultado ou cadastrado');
    expect(cartola.getTeamById).not.toHaveBeenCalled();
    expect(teams.consultarStatusAssociacaoTimes).not.toHaveBeenCalled();
  });

  it('accepts exactly 30 distinct IDs and keeps the Telegram preview within message limits', async () => {
    await startBulkRegistrationPrompt();
    const ids = Array.from({ length: 30 }, (_, index) => 2000 + index);
    const preview = await service.handle('54321', ids.join(';'));
    expect(preview?.text.length).toBeLessThan(3900);
    expect(preview?.text).toContain('Times disponíveis: 30');
    expect(cartola.getTeamById).toHaveBeenCalledTimes(30);
    expect(preview?.inlineKeyboard?.flat().every(item => Buffer.byteLength(item.callback_data, 'utf8') <= 64)).toBe(true);
  });

  it('rejects a message exceeding the configured input size', async () => {
    await startBulkRegistrationPrompt();
    const response = await service.handle('54321', '1'.repeat(2001));
    expect(response?.text).toContain('mensagem é muito longa');
    expect(cartola.getTeamById).not.toHaveBeenCalled();
  });

  it('does not parse a list outside an active batch-registration session', async () => {
    await expect(service.handle('54321', '1002,1003')).resolves.toBeNull();
    expect(cartola.getTeamById).not.toHaveBeenCalled();
    expect(teams.consultarStatusAssociacaoTimes).not.toHaveBeenCalled();
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
  });

  it('marks own-profile and other-profile associations without exposing another owner', async () => {
    associations.set(1002, 99);
    const previewPrompt = await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1001,1002,1003');
    expect(preview?.text).toContain('Já cadastrados no seu perfil: 1');
    expect(preview?.text).toContain('Indisponíveis ou associados a outro perfil: 1');
    expect(preview?.text).toContain('#1002');
    expect(preview?.text).not.toContain('99');
    expect(preview?.text).toContain('✅ Times disponíveis: 1');
    expect(preview?.inlineKeyboard?.flat().map(item => item.text)).toContain('✅ Confirmar cadastro');
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
    expect(previewPrompt.text).toContain('Cadastro de vários times');
  });

  it('reports missing and temporarily unavailable Cartola teams without persisting', async () => {
    cartola.getTeamById.mockImplementation(async (timeId: number) => {
      if (timeId === 1002) throw new NotFoundException();
      if (timeId === 1003) throw new Error('temporary outage');
      return { value: { time: { time_id: timeId, nome: `Time ${timeId}` } } };
    });
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    expect(preview?.text).toContain('Não encontrados no Cartola: 1');
    expect(preview?.text).toContain('Consulta temporariamente indisponível: 1');
    expect(preview?.inlineKeyboard?.flat().map(item => item.text)).not.toContain('✅ Confirmar cadastro');
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
  });

  it('limits simultaneous Cartola lookups to four', async () => {
    let active = 0;
    let maximum = 0;
    cartola.getTeamById.mockImplementation(async (timeId: number) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return { value: { time: { time_id: timeId, nome: `Time ${timeId}` } } };
    });
    await startBulkRegistrationPrompt();
    await service.handle('54321', Array.from({ length: 12 }, (_, index) => String(2000 + index)).join(' '));
    expect(maximum).toBeLessThanOrEqual(4);
    expect(cartola.getTeamById).toHaveBeenCalledTimes(12);
  });

  it('confirms a bulk registration only after the explicit callback and reuses the batch service', async () => {
    const prompt = await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
    expect(preview?.inlineKeyboard?.flat().map(item => item.text)).toContain('✅ Confirmar cadastro');

    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    expect(links.resolveActiveUserId).toHaveBeenLastCalledWith('54321');
    expect(teams.adicionarTimesEmLote).toHaveBeenCalledWith(7, [
      expect.objectContaining({ timeId: 1002, nome: 'Time 1002' }),
      expect.objectContaining({ timeId: 1003, nome: 'Time 1003' }),
    ]);
    expect(result?.text).toContain('✅ Cadastro concluído!');
    expect(result?.text).toContain('Adicionados: 2');
    expect(result?.text).toContain('Total de IDs distintos: 2');
    expect(result?.inlineKeyboard?.flat().map(item => item.text)).toEqual([
      '⚽ Voltar à competição', '📋 Cadastrar mais times', '🏠 Menu principal',
    ]);
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
    expect(prompt.text).toContain('Cadastro de vários times');
  });

  it('does not confirm after a revoked Telegram link', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    links.resolveActiveUserId.mockResolvedValueOnce(null);
    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    expect(result?.text).toContain('vínculo POINT FFC não está ativo');
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
  });

  it('rejects bulk callbacks from another user or a different inline message', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    const confirm = button(preview!, '✅ Confirmar cadastro');
    await expect(press('99999', confirm)).resolves.toBeNull();
    await expect(press('54321', confirm, 901)).resolves.toBeNull();
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
  });

  it('processes concurrent duplicate bulk confirmation callbacks at most once', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    const confirm = button(preview!, '✅ Confirmar cadastro');
    const results = await Promise.all([press('54321', confirm), press('54321', confirm)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(teams.adicionarTimesEmLote).toHaveBeenCalledTimes(1);
  });

  it('does not process a bulk confirmation after the session expires', async () => {
    jest.useFakeTimers();
    try {
      await startBulkRegistrationPrompt();
      const preview = await service.handle('54321', '1002,1003');
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
      expect(result?.text).toContain('Sua seleção expirou');
      expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it('cancels the batch journey without persisting and invalidates its callbacks', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    const confirm = button(preview!, '✅ Confirmar cadastro');
    const cancelled = await press('54321', button(preview!, '❌ Cancelar'));
    expect(cancelled?.showMainMenu).toBe(true);
    await expect(press('54321', confirm)).resolves.toBeNull();
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
  });

  it('revalidates associations before batch confirmation and rejects another profile safely', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    associations.set(1002, 88);
    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    expect(result?.text).toContain('Indisponíveis ou associados a outro perfil: 1');
    expect(result?.text).toContain('#1002');
    expect(result?.text).not.toContain('88');
    expect(teams.adicionarTimesEmLote).toHaveBeenCalledWith(7, [expect.objectContaining({ timeId: 1003 })]);
  });

  it('revalidates Cartola and skips the write when an available team disappears', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002');
    cartola.getTeamById.mockRejectedValueOnce(new NotFoundException());
    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    expect(cartola.getTeamById).toHaveBeenLastCalledWith(1002, { forceRefresh: true });
    expect(result?.text).toContain('Não encontrados: 1');
    expect(teams.adicionarTimesEmLote).not.toHaveBeenCalled();
  });

  it('allows replacing the preview list without retaining earlier candidate IDs', async () => {
    await startBulkRegistrationPrompt();
    const firstPreview = await service.handle('54321', '1002');
    const prompt = await press('54321', button(firstPreview!, '✏️ Enviar outra lista'));
    expect(prompt?.text).toContain('Cadastro de vários times');
    const secondPreview = await service.handle('54321', '1003');
    expect(secondPreview?.text).toContain('Time 1003 — #1003');
    expect(secondPreview?.text).not.toContain('#1002');
  });

  it('reports partial batch success and pending IDs without retrying uncertain writes', async () => {
    teams.adicionarTimesEmLote.mockImplementationOnce(async (usuarioId: number, items: Array<{ timeId: number }>) => {
      associations.set(items[0].timeId, usuarioId);
      return { solicitados: items.length, adicionados: 1, jaExistentes: 0, falhas: [{ timeId: items[1].timeId, motivo: 'erro_persistencia' }],
        timesAdicionados: [items[0].timeId], timesJaExistentes: [] };
    });
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002,1003');
    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    expect(result?.text).toContain('Adicionados: 1');
    expect(result?.text).toContain('Pendentes por falha temporária ou resultado incerto: 1');
    expect(result?.text).toContain('#1003');
    expect(teams.adicionarTimesEmLote).toHaveBeenCalledTimes(1);
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('checks persisted state after an uncertain batch result and never repeats the write', async () => {
    teams.adicionarTimesEmLote.mockImplementationOnce(async (usuarioId: number, items: Array<{ timeId: number }>) => {
      associations.set(items[0].timeId, usuarioId);
      throw new Error('connection lost after commit');
    });
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002');
    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    expect(result?.text).toContain('Já cadastrados no seu perfil: 1');
    expect(teams.adicionarTimesEmLote).toHaveBeenCalledTimes(1);
    expect(teams.consultarStatusAssociacaoTimes).toHaveBeenCalledTimes(3);
  });

  it('returns to the FREE competition with the updated team list and does not enroll automatically', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002');
    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    teams.listarTimesDoUsuario.mockResolvedValue([team(1001), team(1002, 'Time 1002')]);
    const returned = await press('54321', button(result!, '⚽ Voltar à competição'));
    expect(competitions.buscarGratuitaElegivel).toHaveBeenCalledWith(42);
    expect(returned?.inlineKeyboard?.flat().some(item => item.text.includes('Time 1002'))).toBe(true);
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('does not present an enrollment or a false single-team success when the competition closed', async () => {
    await startBulkRegistrationPrompt();
    const preview = await service.handle('54321', '1002');
    const result = await press('54321', button(preview!, '✅ Confirmar cadastro'));
    competitions.buscarGratuitaElegivel.mockResolvedValueOnce(null);
    competitions.listarGratuitasElegiveis.mockResolvedValueOnce([]);
    const returned = await press('54321', button(result!, '⚽ Voltar à competição'));
    expect(returned?.text).toContain('A competição deixou de estar disponível');
    expect(returned?.text).toContain('Não há competições gratuitas abertas');
    expect(returned?.text).not.toContain('Time adicionado ao seu perfil');
    expect(returned?.inlineKeyboard?.flat().map(item => item.text)).toContain('📋 Cadastrar mais times');
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('accepts only a single bounded numeric ID during the registration input step', async () => {
    await startRegistrationPrompt();
    const invalid = await service.handle('54321', '13933388,13933389');
    expect(invalid?.text).toContain('somente um ID numérico');
    expect(cartola.getTeamById).not.toHaveBeenCalled();
    await service.clear('54321');
    await expect(service.handle('54321', '13933388')).resolves.toMatchObject({ text: expect.stringContaining('expirou ou foi reiniciada') });
    expect(cartola.getTeamById).not.toHaveBeenCalled();
  });

  it.each(['0', '4294967296', '12345678901', '-10', '1 2'])('rejects unsupported Cartola ID input %s', async id => {
    await startRegistrationPrompt();
    const response = await service.handle('54321', id);
    expect(response?.text).toMatch(/ID numérico|intervalo aceito/);
    expect(cartola.getTeamById).not.toHaveBeenCalled();
    expect(teams.adicionarTime).not.toHaveBeenCalled();
  });

  it('returns to the prompt when the Cartola team ID does not exist', async () => {
    cartola.getTeamById.mockRejectedValueOnce(new NotFoundException());
    const prompt = await startRegistrationPrompt();
    const response = await service.handle('54321', '13933388');
    expect(response?.text).toContain('Não encontramos esse time no Cartola');
    expect(response?.inlineKeyboard?.flat().map(item => item.text)).toEqual(prompt.inlineKeyboard?.flat().map(item => item.text));
    expect(teams.adicionarTime).not.toHaveBeenCalled();
  });

  it('handles Cartola outage without persisting an association', async () => {
    cartola.getTeamById.mockRejectedValueOnce(new Error('Cartola unavailable'));
    await startRegistrationPrompt();
    const response = await service.handle('54321', '13933388');
    expect(response?.text).toContain('Não foi possível consultar o Cartola');
    expect(teams.adicionarTime).not.toHaveBeenCalled();
  });

  it('shows official Cartola data in a preview and does not persist before confirmation', async () => {
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    expect(preview?.text).toContain('Real Prime CFC');
    expect(preview?.text).toContain('13933388');
    expect(preview?.inlineKeyboard?.flat().map(item => item.text)).toContain('✅ Adicionar ao meu perfil');
    expect(cartola.getTeamById).toHaveBeenCalledWith(13933388);
    expect(teams.adicionarTime).not.toHaveBeenCalled();
  });

  it('persists only after explicit confirmation using the active linked user and no enrollment', async () => {
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    expect(teams.adicionarTime).not.toHaveBeenCalled();
    const result = await press('54321', button(preview!, '✅ Adicionar ao meu perfil'));
    expect(result?.text).toContain('✅ Time adicionado ao seu perfil!');
    expect(links.resolveActiveUserId).toHaveBeenCalledWith('54321');
    expect(teams.adicionarTime).toHaveBeenCalledWith(7, expect.objectContaining({
      timeId: 13933388, nome: 'Real Prime CFC', nomeCartola: 'Cartoleiro',
    }));
    expect(cartola.getTeamById).toHaveBeenLastCalledWith(13933388, { forceRefresh: true });
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('does not persist when the Telegram link is revoked before confirmation', async () => {
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    links.resolveActiveUserId.mockResolvedValueOnce(null);
    const response = await press('54321', button(preview!, '✅ Adicionar ao meu perfil'));
    expect(response?.text).toContain('vínculo POINT FFC não está ativo');
    expect(teams.adicionarTime).not.toHaveBeenCalled();
  });

  it('rejects registration callback after session expiry', async () => {
    jest.useFakeTimers();
    try {
      await startRegistrationPrompt();
      const preview = await service.handle('54321', '13933388');
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      const response = await press('54321', button(preview!, '✅ Adicionar ao meu perfil'));
      expect(response?.text).toContain('Sua seleção expirou');
      expect(teams.adicionarTime).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it('rejects adulterated and repeated confirmation callbacks', async () => {
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    const confirm = button(preview!, '✅ Adicionar ao meu perfil');
    await expect(press('54321', `${confirm}x`)).resolves.toBeNull();
    const result = await press('54321', confirm);
    expect(result?.text).toContain('Time adicionado');
    await expect(press('54321', confirm)).resolves.toBeNull();
    expect(teams.adicionarTime).toHaveBeenCalledTimes(1);
  });

  it('does not reveal or associate a team already assigned to a different profile', async () => {
    teams.adicionarTime.mockResolvedValueOnce({ status: 'ja_existente', timeId: 13933388 });
    teams.buscarTimeDoUsuario.mockResolvedValueOnce(null);
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    const response = await press('54321', button(preview!, '✅ Adicionar ao meu perfil'));
    expect(response?.text).toContain('não pode ser associado ao seu perfil');
    expect(response?.text).not.toContain('usuarioId');
    expect(response?.text).not.toContain('Time adicionado');
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('treats same-profile repeat as already registered and does not duplicate', async () => {
    teams.adicionarTime.mockResolvedValueOnce({ status: 'ja_existente', timeId: 13933388 });
    teams.buscarTimeDoUsuario.mockResolvedValueOnce(team(13933388));
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    const response = await press('54321', button(preview!, '✅ Adicionar ao meu perfil'));
    expect(response?.text).toContain('já está cadastrado no seu perfil');
    expect(teams.adicionarTime).toHaveBeenCalledTimes(1);
  });

  it('checks persisted state after an uncertain write and never retries the insertion', async () => {
    teams.adicionarTime.mockRejectedValueOnce(new Error('connection lost after commit'));
    teams.buscarTimeDoUsuario.mockResolvedValueOnce(team(13933388));
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    const response = await press('54321', button(preview!, '✅ Adicionar ao meu perfil'));
    expect(response?.text).toContain('Time adicionado ao seu perfil');
    expect(teams.adicionarTime).toHaveBeenCalledTimes(1);
    expect(teams.buscarTimeDoUsuario).toHaveBeenCalledWith(7, 13933388);
  });

  it('returns to the still-open competition with the newly registered team loaded', async () => {
    teams.adicionarTime.mockImplementation(async (_usuarioId: number, dados: { timeId: number; nome: string }) => {
      teams.listarTimesDoUsuario.mockResolvedValue([team(1001), team(dados.timeId, dados.nome)]);
      return { status: 'adicionado', timeId: dados.timeId };
    });
    await startRegistrationPrompt();
    const preview = await service.handle('54321', '13933388');
    const receipt = await press('54321', button(preview!, '✅ Adicionar ao meu perfil'));
    const returned = await press('54321', button(receipt!, '⚽ Voltar à competição'));
    expect(competitions.buscarGratuitaElegivel).toHaveBeenCalledWith(42);
    expect(returned?.inlineKeyboard?.flat().some(item => item.text.includes('Real Prime CFC'))).toBe(true);
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
  });

  it('lists only the linked user registrations and pages them using inline controls', async () => {
    inscriptions.minhasDoUsuario.mockResolvedValue(Array.from({ length: 9 }, (_, index) => ({
      id: index + 1, timeIdCartola: 1000 + index, nomeTime: `Time ${index + 1}`, dataInscricao: new Date(),
      competicao: { nome: 'Liga atual', rodadaInicio: 12, rodadaFim: 12, dataFim: new Date(Date.now() + 100_000) },
    })));
    const page = await service.startMyRegistrations('54321');
    expect(links.resolveActiveUserId).toHaveBeenCalledWith('54321');
    expect(inscriptions.minhasDoUsuario).toHaveBeenCalledWith(7);
    expect(page.text).toContain('Liga atual (Rodada 12)');
    expect(page.text).toContain('Time 1 (#1000)');
    expect(page.text).not.toContain('Time 9');
    expect(page.inlineKeyboard?.flat().map(item => item.text)).toContain('➡️ Próxima');
  });

  it('rejects Minhas inscrições when the Telegram link is missing', async () => {
    links.resolveActiveUserId.mockResolvedValueOnce(null);
    const page = await service.startMyRegistrations('54321');
    expect(page.text).toContain('conecte sua conta POINT FFC');
    expect(inscriptions.minhasDoUsuario).not.toHaveBeenCalled();
  });

  it('returns to the menu and invalidates the active competition callback', async () => {
    const page = await service.start('54321');
    service.attachInlineMessage('54321', page.sessionToken!, '54321', 900);
    const select = button(page, '1. POINT FFC - Rodada 42 (R42)');
    const home = await press('54321', button(page, '🏠 Menu principal'));
    expect(home?.showMainMenu).toBe(true);
    expect(home?.editMessage).toBe(true);
    expect(home?.inlineKeyboard).toEqual([]);
    expect(await press('54321', select)).toBeNull();
  });

  it('opens Minhas inscrições from a completed receipt without changing the persisted enrollment', async () => {
    const initial = await startTeams();
    const selected = await press('54321', button(initial, '⬜ Time 1001 (#1001)'));
    const summary = await press('54321', button(selected!, '✅ Continuar (1)'));
    const receipt = await press('54321', button(summary!, '✅ Confirmar inscrição'));
    expect(receipt?.inlineKeyboard?.flat().map(item => item.text)).toEqual(['📋 Minhas inscrições', '🏠 Menu principal']);
    inscriptions.minhasDoUsuario.mockResolvedValueOnce([{
      id: 1, timeIdCartola: 1001, nomeTime: 'Time 1001', dataInscricao: new Date(),
      competicao: { nome: 'POINT FFC - Rodada 42', rodadaInicio: 42, rodadaFim: 42, dataFim: null },
    }]);
    const list = await press('54321', button(receipt!, '📋 Minhas inscrições'));
    expect(list?.text).toContain('POINT FFC - Rodada 42');
    expect(list?.text).toContain('Time 1001 (#1001)');
    expect(enrollmentBatches.criarFree).toHaveBeenCalledTimes(1);
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
    expect(summary?.inlineKeyboard?.flat().map(item => item.text)).toEqual(['✅ Confirmar inscrição', '↩️ Voltar', '❌ Cancelar', '🏠 Menu principal']);
    expect(button(summary!, '✅ Confirmar inscrição').length).toBeLessThanOrEqual(64);
    expect(enrollmentBatches.criarFree).not.toHaveBeenCalled();
    expect(Object.keys(inscriptions)).toEqual(['minhas', 'minhasDoUsuario']);

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
    expect(first?.inlineKeyboard?.flat().map(item => item.text)).toEqual(['📋 Minhas inscrições', '🏠 Menu principal']);
    expect(first?.inlineKeyboard?.flat().some(item => item.text === '❌ Cancelar')).toBe(false);
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
