import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CompeticaoCardDto } from '../ligas-competicoes/dto/ligas-competicoes-response.dto';
import { MinhaInscricaoDto } from '../ligas-competicoes/dto/inscricoes-competicao.dto';
import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { MeusTimesService } from '../meus-times/meus-times.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramCompetitionsService } from './telegram-competitions.service';

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 1000;
const PAGE_SIZE = 8;
const CANCEL_BUTTON = '❌ Cancelar';
const PREVIOUS_BUTTON = '⬅️ Anterior';
const MORE_BUTTON = '➡️ Mais opções';
const LINK_URL = 'https://pointffc.com.br/conectar-telegram/';
const CALLBACK_PREFIX = 'pfc';
const SELECT_ALL_BUTTON = '☑️ Selecionar todos';
const DESELECT_ALL_BUTTON = '⬜ Desmarcar todos';
const CLEAR_SELECTION_BUTTON = '🗑️ Limpar seleção';

type SelectionStage = 'competitions' | 'teams' | 'summary';
interface Option<T> { button: string; value: T }
interface EligibilitySnapshot {
  competition: CompeticaoCardDto | null;
  registrations: MinhaInscricaoDto[];
  teams: Array<{ timeId: number; nome: string }>;
  activeParticipants: number;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

interface SelectionSession {
  telegramUserId: string;
  stage: SelectionStage;
  expiresAt: number;
  competitions: CompeticaoCardDto[];
  competitionId?: number;
  page: number;
  competitionOptions: Option<number>[];
  allTeams: Array<{ id: number; name: string }>;
  selectedTeamIds: number[];
  maxSelectableTeams: number;
  sessionToken: string;
  callbackNonce: string;
  chatId?: string;
  inlineMessageId?: number;
}

export interface TelegramSelectionResponse {
  text: string;
  buttons: string[][];
  inlineKeyboard?: TelegramInlineButton[][];
  sessionToken?: string;
  editMessage?: boolean;
  clearSession?: boolean;
  answerText?: string;
  followUpMessages?: string[];
}

export interface TelegramSelectionCallback {
  telegramUserId: string;
  chatId: string;
  messageId: number;
  data: string;
}

@Injectable()
export class TelegramSelectionService {
  private readonly sessions = new Map<string, SelectionSession>();
  private readonly userQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly competitions: TelegramCompetitionsService,
    private readonly links: TelegramLinkService,
    private readonly teams: MeusTimesService,
    private readonly inscriptions: InscricoesCompeticaoService,
  ) {}

  async start(telegramUserId: string): Promise<TelegramSelectionResponse> {
    this.sessions.delete(telegramUserId);
    let competitions: CompeticaoCardDto[];
    try {
      competitions = await this.competitions.listarGratuitasElegiveis();
    } catch {
      return this.main('Não foi possível consultar as competições gratuitas agora. Tente novamente em instantes.');
    }
    if (competitions.length === 0) {
      return this.main('No momento, não há competições gratuitas abertas para participação.');
    }

    const session: SelectionSession = {
      telegramUserId,
      stage: 'competitions',
      expiresAt: Date.now() + SESSION_TTL_MS,
      competitions,
      page: 0,
      competitionOptions: [],
      allTeams: [],
      selectedTeamIds: [],
      maxSelectableTeams: 0,
      sessionToken: randomBytes(12).toString('base64url'),
      callbackNonce: '',
    };
    this.saveSession(session);
    return this.competitionsPage(session);
  }

  clear(telegramUserId: string): void {
    this.sessions.delete(telegramUserId);
  }

  clearIfSession(telegramUserId: string, sessionToken?: string): void {
    if (!sessionToken || this.sessions.get(telegramUserId)?.sessionToken === sessionToken) {
      this.sessions.delete(telegramUserId);
    }
  }

  attachInlineMessage(telegramUserId: string, sessionToken: string, chatId: string, messageId: number): boolean {
    const session = this.sessions.get(telegramUserId);
    if (!session || session.sessionToken !== sessionToken || session.stage !== 'teams') return false;
    session.chatId = chatId;
    session.inlineMessageId = messageId;
    this.refresh(session);
    return true;
  }

  async handle(telegramUserId: string, text: string): Promise<TelegramSelectionResponse | null> {
    return this.serializeUser(telegramUserId, () => this.handleSequentially(telegramUserId, text));
  }

  async handleCallback(callback: TelegramSelectionCallback): Promise<TelegramSelectionResponse | null> {
    return this.serializeUser(callback.telegramUserId, async () => {
      const session = this.sessions.get(callback.telegramUserId);
      if (!session || !this.isCurrentCallback(session, callback)) return null;
      if (session.expiresAt <= Date.now()) {
        this.sessions.delete(callback.telegramUserId);
        return {
          text: 'Sua seleção expirou. Toque em “⚽ Participar grátis” para começar novamente.',
          buttons: [],
          sessionToken: session.sessionToken,
          inlineKeyboard: [],
          editMessage: true,
          answerText: 'Seleção expirada. Inicie novamente pelo menu.',
        };
      }
      if (session.stage !== 'teams' && session.stage !== 'summary') return null;
      const action = this.callbackAction(session, callback.data);
      if (!action) return null;
      if (action === 'cancel') {
        const { sessionToken } = session;
        this.sessions.delete(session.telegramUserId);
        return { text: 'Jornada cancelada.', buttons: [], sessionToken, inlineKeyboard: [], editMessage: true };
      }
      if (action === 'continue') return this.continueSelection(session);
      if (action === 'edit-selection') {
        session.stage = 'teams';
        this.refresh(session);
        return { ...this.renderTeams(session), editMessage: true };
      }
      if (session.stage !== 'teams') return null;

      let notice = '';
      if (action === 'previous' || action === 'next') {
        const lastPage = Math.max(0, Math.ceil(session.allTeams.length / PAGE_SIZE) - 1);
        const nextPage = action === 'previous' ? session.page - 1 : session.page + 1;
        if (nextPage >= 0 && nextPage <= lastPage) session.page = nextPage;
      } else if (action === 'toggle-all') {
        const allSelected = this.isAllSelected(session);
        if (allSelected) {
          session.selectedTeamIds = [];
        } else {
          session.selectedTeamIds = session.allTeams.slice(0, session.maxSelectableTeams).map(team => team.id);
          if (session.maxSelectableTeams < session.allTeams.length) {
            notice = `Selecionamos ${session.maxSelectableTeams} times. O limite disponível para esta competição é de ${session.maxSelectableTeams}.`;
          }
        }
      } else if (action === 'clear') {
        session.selectedTeamIds = [];
      } else if (action.startsWith('toggle-team:')) {
        const teamId = Number(action.slice('toggle-team:'.length));
        if (!session.allTeams.some(team => team.id === teamId)) {
          notice = 'Esse time não está mais elegível para seleção.';
        } else if (session.selectedTeamIds.includes(teamId)) {
          session.selectedTeamIds = session.selectedTeamIds.filter(id => id !== teamId);
        } else if (session.selectedTeamIds.length >= session.maxSelectableTeams) {
          notice = `O limite disponível para esta competição é de ${session.maxSelectableTeams} time(s).`;
        } else {
          session.selectedTeamIds = [...session.selectedTeamIds, teamId].sort((a, b) => a - b);
        }
      }

      this.refresh(session);
      return { ...this.renderTeams(session, notice), editMessage: true };
    });
  }

  private async continueSelection(session: SelectionSession): Promise<TelegramSelectionResponse> {
    if (session.selectedTeamIds.length === 0) {
      this.refresh(session);
      return { ...this.renderTeams(session, 'Selecione pelo menos um time para continuar.'), editMessage: true };
    }

    let usuarioId: number | null;
    try {
      usuarioId = await this.resolveUser(session.telegramUserId);
    } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível verificar seu vínculo. Tente novamente.' };
    }
    if (usuarioId === null) {
      this.sessions.delete(session.telegramUserId);
      return {
        text: `Não foi possível confirmar seu vínculo ativo. Conecte sua conta POINT FFC:\n${LINK_URL}`,
        buttons: [],
        sessionToken: session.sessionToken,
        inlineKeyboard: [],
        editMessage: true,
        answerText: 'Vínculo não disponível. Conecte sua conta POINT FFC.',
      };
    }

    let eligibility: EligibilitySnapshot;
    try {
      eligibility = await this.loadEligibility(session, usuarioId);
    } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível atualizar a elegibilidade. Tente novamente.' };
    }
    if (!eligibility.competition) {
      this.sessions.delete(session.telegramUserId);
      return {
        text: 'A competição deixou de estar disponível para participação gratuita. Toque em “⚽ Participar grátis” para consultar novamente.',
        buttons: [],
        sessionToken: session.sessionToken,
        inlineKeyboard: [],
        editMessage: true,
        answerText: 'Competição indisponível. Consulte novamente pelo menu.',
      };
    }

    const priorEligibleIds = session.allTeams.map(team => team.id);
    const priorCapacity = session.maxSelectableTeams;
    this.applyEligibility(session, eligibility);
    const eligibilityChanged = priorCapacity !== session.maxSelectableTeams
      || priorEligibleIds.toString() !== session.allTeams.map(team => team.id).toString();
    if (eligibilityChanged) {
      session.selectedTeamIds = [];
      session.page = 0;
      session.stage = 'teams';
      this.refresh(session);
      return {
        ...this.renderTeams(session, 'A elegibilidade mudou desde o carregamento. A seleção foi limpa; revise os times atualizados e selecione novamente.'),
        editMessage: true,
      };
    }

    session.stage = 'summary';
    this.refresh(session);
    return { ...this.renderSummary(session, eligibility.competition), editMessage: true };
  }

  private async serializeUser<T>(telegramUserId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.userQueues.get(telegramUserId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.userQueues.set(telegramUserId, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.userQueues.get(telegramUserId) === current) this.userQueues.delete(telegramUserId);
    }
  }

  private async handleSequentially(telegramUserId: string, text: string): Promise<TelegramSelectionResponse | null> {
    const session = this.sessions.get(telegramUserId);
    if (!session) {
      return this.isSelectionInput(text.trim())
        ? this.main('Sua seleção expirou ou foi reiniciada. Toque em “⚽ Participar grátis” para começar novamente.')
        : null;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(telegramUserId);
      return this.main('Sua seleção expirou. Toque em “⚽ Participar grátis” para começar novamente.');
    }

    const input = text.trim();
    if (input === CANCEL_BUTTON) {
      this.sessions.delete(telegramUserId);
      return this.main('Jornada cancelada.');
    }

    if (session.stage === 'competitions') return this.handleCompetitionStep(session, input);
    return null;
  }

  private async handleCompetitionStep(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
    if (input === PREVIOUS_BUTTON && session.page > 0) {
      session.page -= 1;
      this.refresh(session);
      return this.competitionsPage(session);
    }
    if (input === MORE_BUTTON && (session.page + 1) * PAGE_SIZE < session.competitions.length) {
      session.page += 1;
      this.refresh(session);
      return this.competitionsPage(session);
    }
    const option = session.competitionOptions.find(item => item.button === input);
    if (!option) return this.competitionsPage(session, 'Escolha uma das competições pelos botões abaixo.');

    let usuarioId: number | null;
    try {
      usuarioId = await this.resolveUser(session.telegramUserId);
    } catch {
      return this.main('Não foi possível verificar seu vínculo agora. Tente novamente em instantes.');
    }
    if (usuarioId === null) {
      this.sessions.delete(session.telegramUserId);
      return this.main(`Para participar, conecte sua conta POINT FFC primeiro:\n${LINK_URL}`);
    }

    try {
      return await this.showTeams(session, option.value, usuarioId);
    } catch {
      return this.main('Não foi possível consultar seus times agora. Tente iniciar a jornada novamente em instantes.');
    }
  }

  private async showTeams(session: SelectionSession, competitionId: number, usuarioId: number): Promise<TelegramSelectionResponse> {
    session.stage = 'teams';
    session.competitionId = competitionId;
    session.page = 0;
    const eligibility = await this.loadEligibility(session, usuarioId);
    if (!eligibility.competition) {
      session.stage = 'competitions';
      this.sessions.delete(session.telegramUserId);
      return this.main('A competição deixou de estar disponível para participação gratuita. Consulte novamente pelo menu.');
    }
    this.applyEligibility(session, eligibility);
    this.refresh(session);
    return this.renderTeams(session);
  }

  private competitionsPage(session: SelectionSession, prefix = ''): TelegramSelectionResponse {
    session.page = this.validPage(session.page, session.competitions.length);
    const start = session.page * PAGE_SIZE;
    const pageItems = session.competitions.slice(start, start + PAGE_SIZE);
    session.competitionOptions = pageItems.map((competition, index) => ({
      button: `${start + index + 1}. ${this.truncate(competition.nome, 38)} (R${competition.rodadaInicio ?? '—'}, #${competition.id})`,
      value: competition.id,
    }));
    const lines = pageItems.map((competition, index) => `${index + 1}. ${this.formatCompetition(competition)}`);
    const buttons = this.rows(session.competitionOptions.map(option => option.button));
    if (start > 0) buttons.push([PREVIOUS_BUTTON]);
    if (start + PAGE_SIZE < session.competitions.length) buttons.push([MORE_BUTTON]);
    buttons.push([CANCEL_BUTTON]);
    return {
      text: `${prefix ? `${prefix}\n\n` : ''}⚽ Competições gratuitas abertas — escolha uma opção:\n\n${lines.join('\n\n')}`,
      buttons,
    };
  }

  private async loadEligibility(session: SelectionSession, usuarioId: number): Promise<EligibilitySnapshot> {
    if (!session.competitionId) return { competition: null, registrations: [], teams: [], activeParticipants: 0 };
    const competition = await this.competitions.buscarGratuitaElegivel(session.competitionId);
    if (!competition) return { competition: null, registrations: [], teams: [], activeParticipants: 0 };
    const [registrations, ownedTeams, activeParticipants] = await Promise.all([
      this.inscriptions.minhas(competition.id, usuarioId),
      this.teams.listarTimesDoUsuario(usuarioId),
      this.competitions.contarParticipantesAtivos(competition.id),
    ]);
    return { competition, registrations, teams: ownedTeams, activeParticipants };
  }

  private applyEligibility(session: SelectionSession, snapshot: EligibilitySnapshot): number {
    if (!snapshot.competition) return session.selectedTeamIds.length;
    const competitionIndex = session.competitions.findIndex(item => item.id === snapshot.competition?.id);
    if (competitionIndex >= 0) session.competitions[competitionIndex] = snapshot.competition;
    const registeredIds = new Set(snapshot.registrations.map(registration => registration.timeIdCartola));
    session.allTeams = snapshot.teams
      .filter(team => !registeredIds.has(team.timeId))
      .map(team => ({ id: team.timeId, name: team.nome }))
      .sort((left, right) => left.id - right.id);

    const activeUserCount = snapshot.registrations
      .filter(registration => registration.statusInscricao === 'ATIVA').length;
    const userSlots = snapshot.competition.limiteTimesUsuario === null
      ? session.allTeams.length
      : Math.max(0, snapshot.competition.limiteTimesUsuario - activeUserCount);
    const participantSlots = snapshot.competition.limiteParticipantes === null
      ? session.allTeams.length
      : Math.max(0, snapshot.competition.limiteParticipantes - snapshot.activeParticipants);
    session.maxSelectableTeams = Math.max(0, Math.min(session.allTeams.length, userSlots, participantSlots));

    const before = session.selectedTeamIds.length;
    const eligibleIds = new Set(session.allTeams.map(team => team.id));
    session.selectedTeamIds = session.selectedTeamIds
      .filter(id => eligibleIds.has(id))
      .sort((left, right) => left - right)
      .slice(0, session.maxSelectableTeams);
    session.page = this.validPage(session.page, session.allTeams.length);
    return before - session.selectedTeamIds.length;
  }

  private renderTeams(session: SelectionSession, prefix = ''): TelegramSelectionResponse {
    session.stage = 'teams';
    session.page = this.validPage(session.page, session.allTeams.length);
    session.callbackNonce = randomBytes(6).toString('base64url');
    const start = session.page * PAGE_SIZE;
    const pageItems = session.allTeams.slice(start, start + PAGE_SIZE);
    const selected = new Set(session.selectedTeamIds);
    const keyboard: TelegramInlineButton[][] = pageItems.map(team => [{
      text: `${selected.has(team.id) ? '✅' : '⬜'} ${this.truncate(team.name, 32)} (#${team.id})`,
      callback_data: this.callbackData(session, `toggle-team:${team.id.toString(36)}`),
    }]);
    const navigation: TelegramInlineButton[] = [];
    if (start > 0) navigation.push({ text: PREVIOUS_BUTTON, callback_data: this.callbackData(session, 'previous') });
    if (start + PAGE_SIZE < session.allTeams.length) navigation.push({ text: '➡️ Próxima', callback_data: this.callbackData(session, 'next') });
    if (navigation.length) keyboard.push(navigation);
    const allSelected = this.isAllSelected(session);
    keyboard.push([{
      text: allSelected ? DESELECT_ALL_BUTTON : SELECT_ALL_BUTTON,
      callback_data: this.callbackData(session, 'toggle-all'),
    }]);
    keyboard.push([{ text: CLEAR_SELECTION_BUTTON, callback_data: this.callbackData(session, 'clear') }]);
    if (session.selectedTeamIds.length > 0) {
      keyboard.push([{
        text: `✅ Continuar (${session.selectedTeamIds.length})`,
        callback_data: this.callbackData(session, 'continue'),
      }]);
    }
    keyboard.push([{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }]);

    const competition = session.competitions.find(item => item.id === session.competitionId);
    const countText = `Times selecionados: ${session.selectedTeamIds.length}`;
    const limitText = session.maxSelectableTeams < session.allTeams.length
      ? `\nLimite disponível: ${session.maxSelectableTeams}` : '';
    const pageText = session.allTeams.length > PAGE_SIZE
      ? `\nPágina ${session.page + 1} de ${Math.ceil(session.allTeams.length / PAGE_SIZE)}` : '';
    const emptyText = session.allTeams.length === 0 || session.maxSelectableTeams === 0
      ? '\nNão há times elegíveis disponíveis nesta competição.' : '';
    return {
      text: `${prefix ? `${prefix}\n\n` : ''}${competition ? `${this.formatCompetition(competition)}\n\n` : ''}Escolha seus times pelos botões abaixo.\n${countText}${limitText}${pageText}${emptyText}`,
      buttons: [],
      inlineKeyboard: keyboard,
      sessionToken: session.sessionToken,
    };
  }

  private renderSummary(
    session: SelectionSession,
    competition: CompeticaoCardDto,
    prefix = '',
  ): TelegramSelectionResponse {
    session.callbackNonce = randomBytes(6).toString('base64url');
    const selectedIds = new Set(session.selectedTeamIds);
    const selectedTeams = session.allTeams.filter(team => selectedIds.has(team.id));
    const teamLines = selectedTeams.map(team => `• ${this.truncate(team.name, 100)} (#${team.id})`);
    const round = competition.rodadaInicio === null ? '—'
      : competition.rodadaFim !== null && competition.rodadaFim !== competition.rodadaInicio
        ? `${competition.rodadaInicio}–${competition.rodadaFim}` : `${competition.rodadaInicio}`;
    const heading = `${prefix ? `${prefix}\n\n` : ''}Resumo da seleção\n\nCompetição: ${this.truncate(competition.nome, 180)}\nRodada: ${round}\nTimes selecionados: ${selectedTeams.length}\nValor total: R$ 0,00\n\n`;
    const footer = '\n\nOs times foram selecionados, mas nenhuma inscrição foi realizada.';
    const primaryLines: string[] = [];
    const overflowLines: string[] = [];
    for (const line of teamLines) {
      const candidate = `${heading}${[...primaryLines, line].join('\n')}${footer}`;
      if (candidate.length <= 3900) primaryLines.push(line);
      else overflowLines.push(line);
    }
    const followUpMessages: string[] = [];
    let current = 'Continuação dos times selecionados:\n';
    for (const line of overflowLines) {
      if (current.length + line.length + 1 > 3900) {
        followUpMessages.push(current.trim());
        current = 'Continuação dos times selecionados:\n';
      }
      current += `${line}\n`;
    }
    if (current.trim() !== 'Continuação dos times selecionados:') followUpMessages.push(current.trim());
    const text = `${heading}${primaryLines.join('\n')}${footer}`;
    return {
      text,
      buttons: [],
      sessionToken: session.sessionToken,
      ...(followUpMessages.length ? { followUpMessages } : {}),
      inlineKeyboard: [[
        { text: '🔄 Alterar seleção', callback_data: this.callbackData(session, 'edit-selection') },
      ], [
        { text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') },
      ]],
    };
  }

  private callbackData(session: SelectionSession, action: string): string {
    return `${CALLBACK_PREFIX}:${session.sessionToken}:${session.callbackNonce}:${action}`;
  }

  private isAllSelected(session: SelectionSession): boolean {
    if (session.maxSelectableTeams === 0) return false;
    const expected = session.allTeams.slice(0, session.maxSelectableTeams).map(team => team.id);
    return expected.length === session.selectedTeamIds.length
      && expected.every((id, index) => id === session.selectedTeamIds[index]);
  }

  private callbackAction(session: SelectionSession, data: string): string | null {
    const prefix = `${CALLBACK_PREFIX}:${session.sessionToken}:${session.callbackNonce}:`;
    if (!data.startsWith(prefix) || Buffer.byteLength(data, 'utf8') > 64) return null;
    const action = data.slice(prefix.length);
    if (['previous', 'next', 'toggle-all', 'clear', 'continue', 'edit-selection', 'cancel'].includes(action)) return action;
    const match = /^toggle-team:([0-9a-z]{1,8})$/.exec(action);
    if (!match) return null;
    const teamId = Number.parseInt(match[1], 36);
    return Number.isSafeInteger(teamId) && teamId > 0 ? `toggle-team:${teamId}` : null;
  }

  private isCurrentCallback(session: SelectionSession, callback: TelegramSelectionCallback): boolean {
    return session.sessionToken.length > 0
      && session.chatId === callback.chatId
      && session.inlineMessageId === callback.messageId
      && this.callbackAction(session, callback.data) !== null;
  }

  private async resolveUser(telegramUserId: string): Promise<number | null> {
    return this.links.resolveActiveUserId(telegramUserId);
  }

  private formatCompetition(competition: CompeticaoCardDto): string {
    const round = competition.rodadaInicio === null ? '—'
      : competition.rodadaFim !== null && competition.rodadaFim !== competition.rodadaInicio
        ? `${competition.rodadaInicio}–${competition.rodadaFim}` : `${competition.rodadaInicio}`;
    const deadline = competition.fimInscricao
      ? `\nPrazo: ${new Date(competition.fimInscricao).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}`
      : '';
    return `🏆 ${this.truncate(competition.nome, 150)}\nRodada: ${round}\nValor: R$ 0,00${deadline}`;
  }

  private rows(buttons: string[]): string[][] {
    const rows: string[][] = [];
    for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
    return rows;
  }

  private main(text: string, buttons = [['🏆 Ver competições'], ['🔗 Conectar minha conta'], ['⚽ Participar grátis']]): TelegramSelectionResponse {
    return { text, buttons };
  }

  private truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  }

  private isSelectionInput(text: string): boolean {
    return text === CANCEL_BUTTON || text === PREVIOUS_BUTTON || text === MORE_BUTTON
      || /^\d+\. .+\(R[^,]+, #\d+\)$/.test(text)
      || /^\d+\. .+\(#\d+\)$/.test(text);
  }

  private validPage(page: number, totalItems: number): number {
    const lastPage = Math.max(0, Math.ceil(totalItems / PAGE_SIZE) - 1);
    return Math.max(0, Math.min(page, lastPage));
  }

  private refresh(session: SelectionSession): void {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    this.saveSession(session);
  }

  private saveSession(session: SelectionSession): void {
    const now = Date.now();
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(key);
    }
    if (!this.sessions.has(session.telegramUserId) && this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    this.sessions.set(session.telegramUserId, session);
  }
}
