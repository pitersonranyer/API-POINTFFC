import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CompeticaoCardDto } from '../ligas-competicoes/dto/ligas-competicoes-response.dto';
import { MinhaInscricaoDto } from '../ligas-competicoes/dto/inscricoes-competicao.dto';
import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { LotesInscricaoService } from '../ligas-competicoes/lotes-inscricao.service';
import { MeusTimesService } from '../meus-times/meus-times.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramCompetitionsService } from './telegram-competitions.service';

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 1000;
const PAGE_SIZE = 8;
const MAX_BATCH_TEAMS = 50;
const CANCEL_BUTTON = '❌ Cancelar';
const BACK_BUTTON = '↩️ Voltar';
const PREVIOUS_BUTTON = '⬅️ Anterior';
const MORE_BUTTON = '➡️ Mais opções';
const LINK_URL = 'https://pointffc.com.br/conectar-telegram/';
const CALLBACK_PREFIX = 'pfc';
const SELECT_ALL_BUTTON = '☑️ Selecionar todos';
const DESELECT_ALL_BUTTON = '⬜ Desmarcar todos';
const CLEAR_SELECTION_BUTTON = '🗑️ Limpar seleção';
const HOME_BUTTON = '🏠 Menu principal';
const MY_REGISTRATIONS_BUTTON = '📋 Minhas inscrições';

type SelectionStage = 'competitions' | 'teams' | 'summary' | 'receipt' | 'registrations';
interface Option<T> { button: string; value: T }
type TelegramRegistration = { id: number; timeIdCartola: number; nomeTime: string; competitionName: string; round: string; competitionEnd: string | null };
interface EligibilitySnapshot {
  competition: CompeticaoCardDto | null;
  registrations: MinhaInscricaoDto[];
  teams: Array<{ timeId: number; nome: string }>;
  activeParticipants: number;
}
type ConfirmedFreeEnrollment = NonNullable<Awaited<ReturnType<LotesInscricaoService['consultarResultadoFreeConfirmado']>>>;

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
  confirmationKey?: string;
  chatId?: string;
  inlineMessageId?: number;
  myRegistrations?: TelegramRegistration[];
  completedConfirmationCallback?: string;
  linkedUsuarioId?: number;
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
  showMainMenu?: boolean;
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
    private readonly enrollmentBatches: LotesInscricaoService,
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
    return this.renderCompetitionPage(session);
  }

  async startMyRegistrations(telegramUserId: string): Promise<TelegramSelectionResponse> {
    this.sessions.delete(telegramUserId);
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(telegramUserId); } catch {
      return this.main('Não foi possível verificar seu vínculo agora. Tente novamente em instantes.');
    }
    if (usuarioId === null) return this.main('Para consultar suas inscrições, conecte sua conta POINT FFC primeiro:\nhttps://pointffc.com.br/conectar-telegram/');
    try {
      const rows = await this.inscriptions.minhasDoUsuario(usuarioId);
      const registrations = this.mapTelegramRegistrations(rows);
      const session: SelectionSession = {
        telegramUserId, stage: 'registrations', expiresAt: Date.now() + SESSION_TTL_MS,
        competitions: [], page: 0, competitionOptions: [], allTeams: [], selectedTeamIds: [], maxSelectableTeams: 0,
        sessionToken: randomBytes(12).toString('base64url'), callbackNonce: randomBytes(6).toString('base64url'),
        myRegistrations: registrations, linkedUsuarioId: usuarioId,
      };
      this.saveSession(session);
      return this.renderMyRegistrations(session);
    } catch {
      return this.main('Não foi possível consultar suas inscrições agora. Tente novamente em instantes.');
    }
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
    if (!session || session.sessionToken !== sessionToken) return false;
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
      if (!session) return this.recoverConfirmedEnrollment(callback);
      if (session.stage === 'receipt' && session.completedConfirmationCallback === callback.data
        && session.chatId === callback.chatId && session.inlineMessageId === callback.messageId) {
        return this.recoverConfirmedEnrollment(callback);
      }
      if (!this.isCurrentCallback(session, callback)) return null;
      if (session.expiresAt <= Date.now()) {
        const action = this.callbackAction(session, callback.data);
        if (action?.startsWith('confirm:')) {
          const recovered = await this.recoverConfirmedEnrollment(callback);
          if (recovered?.text.startsWith('🏆 Inscrição realizada')) {
            return recovered;
          }
        }
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
      const action = this.callbackAction(session, callback.data);
      if (!action) return null;
      if (action === 'main-menu') return this.endJourney(session, 'Menu principal');
      if (session.stage === 'competitions') {
        if (action === 'cancel') return this.endJourney(session, 'Jornada cancelada.');
        if (action === 'previous' || action === 'next') {
          const lastPage = Math.max(0, Math.ceil(session.competitions.length / PAGE_SIZE) - 1);
          session.page = Math.max(0, Math.min(lastPage, session.page + (action === 'previous' ? -1 : 1)));
          this.refresh(session);
          return { ...this.renderCompetitionPage(session), editMessage: true };
        }
        if (action.startsWith('select-competition:')) {
          const competitionId = Number.parseInt(action.slice('select-competition:'.length), 36);
          if (!session.competitionOptions.some(option => option.value === competitionId)) return null;
          return this.selectCompetition(session, competitionId);
        }
        return null;
      }
      if (session.stage === 'receipt') {
        if (action === 'my-inscriptions') return this.openMyRegistrations(session);
        return null;
      }
      if (session.stage === 'registrations') {
        if (action === 'previous' || action === 'next') {
          let activeUsuarioId: number | null;
          try { activeUsuarioId = await this.resolveUser(session.telegramUserId); } catch {
            return { text: 'Não foi possível verificar seu vínculo agora. Tente novamente.', buttons: [], answerText: 'Tente novamente.' };
          }
          if (activeUsuarioId === null || activeUsuarioId !== session.linkedUsuarioId) {
            return this.endJourney(session, 'Seu vínculo não está ativo. Conecte sua conta POINT FFC para consultar suas inscrições.');
          }
          const lastPage = Math.max(0, Math.ceil((session.myRegistrations?.length ?? 0) / PAGE_SIZE) - 1);
          session.page = Math.max(0, Math.min(lastPage, session.page + (action === 'previous' ? -1 : 1)));
          this.refresh(session);
          return { ...this.renderMyRegistrations(session), editMessage: true };
        }
        return action === 'cancel' ? this.endJourney(session, 'Consulta encerrada.') : null;
      }
      if (session.stage !== 'teams' && session.stage !== 'summary') return null;
      if (action === 'cancel') {
        return this.endJourney(session, 'Jornada cancelada.');
      }
      if (action.startsWith('confirm:')) {
        if (session.stage !== 'summary' || session.confirmationKey !== action.slice('confirm:'.length)) return null;
        return this.confirmEnrollment(session, session.confirmationKey);
      }
      if (action === 'continue') return this.continueSelection(session);
      if (action === 'back-competitions' && session.stage === 'teams') {
        session.stage = 'competitions'; session.competitionId = undefined; session.allTeams = [];
        session.selectedTeamIds = []; session.page = 0; this.refresh(session);
        return { ...this.renderCompetitionPage(session), editMessage: true };
      }
      if (action === 'edit-selection') {
        session.stage = 'teams';
        session.confirmationKey = undefined;
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
    if (!eligibility.competition || eligibility.competition.tipoAcesso !== 'FREE') {
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

  private async selectCompetition(session: SelectionSession, competitionId: number): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { ...this.renderCompetitionPage(session, 'Não foi possível verificar seu vínculo agora.'), editMessage: true };
    }
    if (usuarioId === null) return this.endJourney(session, `Para participar, conecte sua conta POINT FFC primeiro:\n${LINK_URL}`);
    try { return { ...await this.showTeams(session, competitionId, usuarioId), editMessage: true }; } catch {
      return { ...this.renderCompetitionPage(session, 'Não foi possível consultar seus times agora.'), editMessage: true };
    }
  }

  private async openMyRegistrations(session: SelectionSession): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { text: 'Não foi possível verificar seu vínculo agora. Tente novamente.', buttons: [], answerText: 'Tente novamente.' };
    }
    if (usuarioId === null) return this.endJourney(session, 'Seu vínculo não está ativo. Conecte sua conta POINT FFC para consultar suas inscrições.');
    try {
      const rows = await this.inscriptions.minhasDoUsuario(usuarioId);
      session.myRegistrations = this.mapTelegramRegistrations(rows);
      session.linkedUsuarioId = usuarioId;
      session.stage = 'registrations'; session.page = 0; this.refresh(session);
      return { ...this.renderMyRegistrations(session), editMessage: true };
    } catch {
      return { text: 'Não foi possível consultar suas inscrições agora. Tente novamente.', buttons: [], answerText: 'Tente novamente.' };
    }
  }

  private renderMyRegistrations(session: SelectionSession): TelegramSelectionResponse {
    session.callbackNonce = randomBytes(6).toString('base64url');
    const rows = session.myRegistrations ?? [];
    const start = session.page * PAGE_SIZE;
    const page = rows.slice(start, start + PAGE_SIZE);
    const pageCount = Math.ceil(rows.length / PAGE_SIZE);
    const keyboard: TelegramInlineButton[][] = [];
    const navigation: TelegramInlineButton[] = [];
    if (session.page > 0) navigation.push({ text: '⬅️ Anterior', callback_data: this.callbackData(session, 'previous') });
    if (start + PAGE_SIZE < rows.length) navigation.push({ text: '➡️ Próxima', callback_data: this.callbackData(session, 'next') });
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }]);
    keyboard.push([{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }]);
    const text = rows.length === 0 ? '📋 Você ainda não tem inscrições registradas.'
      : `📋 Minhas inscrições${pageCount > 1 ? ` — página ${session.page + 1} de ${pageCount}` : ''}\n\n${page.map(item => `🏆 ${this.truncate(item.competitionName, 120)} (Rodada ${item.round})\n⚽ ${this.truncate(item.nomeTime, 120)} (#${item.timeIdCartola})`).join('\n\n')}`;
    return { text, buttons: [], inlineKeyboard: keyboard, sessionToken: session.sessionToken };
  }

  private endJourney(session: SelectionSession, text: string): TelegramSelectionResponse {
    this.sessions.delete(session.telegramUserId);
    return { text, buttons: [], inlineKeyboard: [], editMessage: true, showMainMenu: true };
  }

  private mapTelegramRegistrations(rows: Awaited<ReturnType<InscricoesCompeticaoService['minhasDoUsuario']>>): TelegramRegistration[] {
    const now = Date.now();
    return rows.map(row => ({
      id: row.id, timeIdCartola: row.timeIdCartola, nomeTime: row.nomeTime,
      competitionName: row.competicao.nome,
      round: row.competicao.rodadaInicio === null ? '—'
        : row.competicao.rodadaFim !== null && row.competicao.rodadaFim !== row.competicao.rodadaInicio
          ? `${row.competicao.rodadaInicio}–${row.competicao.rodadaFim}` : `${row.competicao.rodadaInicio}`,
      competitionEnd: row.competicao.dataFim?.toISOString() ?? null,
      currentOrFuture: (row.competicao.dataInicio?.getTime() ?? 0) >= now
        || (row.competicao.dataFim?.getTime() ?? 0) >= now
        || (!row.competicao.dataInicio && !row.competicao.dataFim
          && row.competicao.status !== 'ENCERRADA' && row.competicao.status !== 'CANCELADA'),
    })).sort((a, b) => Number(b.currentOrFuture) - Number(a.currentOrFuture)
      || (a.competitionEnd ?? '').localeCompare(b.competitionEnd ?? '')
      || a.competitionName.localeCompare(b.competitionName) || a.id - b.id)
      .map(({ currentOrFuture: _currentOrFuture, ...row }) => row);
  }

  private async confirmEnrollment(session: SelectionSession, idempotencyKey: string): Promise<TelegramSelectionResponse> {
    const competition = session.competitions.find(item => item.id === session.competitionId);
    if (!competition || competition.tipoAcesso !== 'FREE' || !session.competitionId) {
      this.sessions.delete(session.telegramUserId);
      return {
        text: 'A competição não está disponível para inscrição gratuita. Inicie novamente pelo menu.',
        buttons: [], sessionToken: session.sessionToken, inlineKeyboard: [], editMessage: true,
      };
    }

    let usuarioId: number | null;
    try {
      usuarioId = await this.resolveUser(session.telegramUserId);
    } catch {
      return this.renderConfirmationFailure(session, competition,
        'Não foi possível verificar seu vínculo agora. A mesma confirmação pode ser tentada novamente com segurança.');
    }
    if (usuarioId === null) {
      this.sessions.delete(session.telegramUserId);
      return {
        text: `Não foi possível confirmar seu vínculo ativo. Conecte sua conta POINT FFC:\n${LINK_URL}`,
        buttons: [], sessionToken: session.sessionToken, inlineKeyboard: [], editMessage: true,
        answerText: 'Vínculo não disponível. Conecte sua conta POINT FFC.',
      };
    }

    try {
      await this.enrollmentBatches.criarFree(session.competitionId, usuarioId, {
        timesCartolaIds: [...session.selectedTeamIds].sort((a, b) => a - b),
        valorUnitarioEsperado: '0.00',
      }, idempotencyKey);
      const confirmed = await this.enrollmentBatches.consultarResultadoFreeConfirmado(usuarioId, idempotencyKey);
      if (!confirmed) {
        return this.renderConfirmationFailure(session, competition,
          'Não foi possível confirmar o resultado persistido. Toque novamente em Confirmar inscrição para consultar esta mesma operação sem duplicá-la.');
      }
      return this.renderEnrollmentSuccess(confirmed, this.keepReceiptSession(session, idempotencyKey));
    } catch (error) {
      const businessMessage = this.businessEnrollmentFailure(error);
      if (businessMessage) {
        return this.refreshSelectionAfterEnrollmentFailure(session, usuarioId, businessMessage);
      }
      return this.renderConfirmationFailure(session, competition,
        'Não foi possível confirmar o resultado. A operação pode ter sido concluída; toque novamente em Confirmar inscrição para consultar a mesma chave persistente sem criar duplicidade.');
    }
  }

  private async recoverConfirmedEnrollment(callback: TelegramSelectionCallback): Promise<TelegramSelectionResponse | null> {
    const idempotencyKey = this.idempotencyKeyFromCallback(callback.data);
    if (!idempotencyKey || callback.chatId !== callback.telegramUserId
      || !Number.isSafeInteger(callback.messageId) || callback.messageId < 1) return null;

    try {
      const usuarioId = await this.resolveUser(callback.telegramUserId);
      if (usuarioId === null) return null;
      const confirmed = await this.enrollmentBatches.consultarResultadoFreeConfirmado(usuarioId, idempotencyKey);
      if (!confirmed) return {
        text: '', buttons: [], answerText: 'Ainda não foi possível localizar uma inscrição confirmada para esta ação. Tente novamente em instantes ou inicie uma nova seleção pelo menu.',
      };
      return this.renderEnrollmentSuccess(confirmed, this.createReceiptSession(callback));
    } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível consultar o resultado agora. Tente novamente em instantes.' };
    }
  }

  private async refreshSelectionAfterEnrollmentFailure(
    session: SelectionSession,
    usuarioId: number,
    notice: string,
  ): Promise<TelegramSelectionResponse> {
    try {
      const eligibility = await this.loadEligibility(session, usuarioId);
      if (!eligibility.competition || eligibility.competition.tipoAcesso !== 'FREE') {
        this.sessions.delete(session.telegramUserId);
        return {
          text: `${notice}\n\nA competição não está mais disponível para participação gratuita.`,
          buttons: [], sessionToken: session.sessionToken, inlineKeyboard: [], editMessage: true,
        };
      }
      this.applyEligibility(session, eligibility);
      session.selectedTeamIds = [];
      session.page = 0;
      session.stage = 'teams';
      session.confirmationKey = undefined;
      this.refresh(session);
      return { ...this.renderTeams(session, `${notice} A lista foi atualizada; selecione os times novamente.`), editMessage: true };
    } catch {
      return this.renderConfirmationFailure(session,
        session.competitions.find(item => item.id === session.competitionId)!, notice);
    }
  }

  private renderConfirmationFailure(
    session: SelectionSession,
    competition: CompeticaoCardDto,
    notice: string,
  ): TelegramSelectionResponse {
    this.refresh(session);
    return { ...this.renderSummary(session, competition, notice, true), editMessage: true };
  }

  private businessEnrollmentFailure(error: unknown): string | null {
    if (!(error instanceof Error) || !('getResponse' in error) || typeof error.getResponse !== 'function') return null;
    const response: unknown = error.getResponse();
    if (!response || typeof response !== 'object' || !('code' in response)) return null;
    const code = (response as { code?: unknown }).code;
    const messages: Record<string, string> = {
      COMPETICAO_NAO_FREE: 'Esta confirmação aceita somente competições gratuitas.',
      INSCRICOES_FECHADAS: 'As inscrições desta competição foram encerradas.',
      FORA_JANELA_INSCRICAO: 'O prazo de inscrição desta competição terminou.',
      COMPETICAO_INDISPONIVEL: 'A competição não está disponível para novas inscrições.',
      LIMITE_PARTICIPANTES_ATINGIDO: 'A capacidade da competição foi atingida.',
      LIMITE_TIMES_USUARIO_ATINGIDO: 'O limite de times por usuário foi atingido.',
      TIME_JA_INSCRITO: 'Um ou mais times já estão inscritos nesta competição.',
      TIME_NAO_PERTENCE_AO_USUARIO: 'A propriedade de um ou mais times não pôde ser confirmada.',
      PRECO_INSCRICAO_ALTERADO: 'Os dados de gratuidade da competição foram alterados.',
    };
    return typeof code === 'string' ? messages[code] ?? null : null;
  }

  private idempotencyKeyFromCallback(data: string): string | null {
    if (Buffer.byteLength(data, 'utf8') > 64) return null;
    const match = /^pfc:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{8}:confirm:([A-Za-z0-9_-]{24})$/.exec(data);
    return match?.[1] ?? null;
  }

  private renderEnrollmentSuccess(
    confirmed: ConfirmedFreeEnrollment,
    session: SelectionSession,
  ): TelegramSelectionResponse {
    const header = `🏆 Inscrição realizada com sucesso!\n\nCompetição: ${this.truncate(confirmed.competenciaNome, 180)}\n\nTimes inscritos:\n`;
    const footer = `\n\nTotal: ${confirmed.resposta.quantidade} ${confirmed.resposta.quantidade === 1 ? 'time' : 'times'}\nValor: R$ 0,00`;
    const selectedLines = confirmed.times.map(time => `• ${this.truncate(time.nomeTime, 200)} (#${time.timeIdCartola})`);
    const visible: string[] = [];
    const overflow: string[] = [];
    for (const line of selectedLines) {
      if (`${header}${[...visible, line].join('\n')}${footer}`.length <= 3900) visible.push(line);
      else overflow.push(line);
    }
    const followUpMessages: string[] = [];
    let current = 'Continuação dos times inscritos:\n';
    for (const line of overflow) {
      if (current.length + line.length + 1 > 3900) {
        followUpMessages.push(current.trim());
        current = 'Continuação dos times inscritos:\n';
      }
      current += `${line}\n`;
    }
    if (current.trim() !== 'Continuação dos times inscritos:') followUpMessages.push(current.trim());
    return {
      text: `${header}${visible.join('\n')}${footer}`,
      buttons: [], inlineKeyboard: [[
        { text: MY_REGISTRATIONS_BUTTON, callback_data: this.callbackData(session, 'my-inscriptions') },
      ], [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }]], sessionToken: session.sessionToken, editMessage: true,
      ...(followUpMessages.length ? { followUpMessages } : {}),
    };
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
    if (!eligibility.competition || eligibility.competition.tipoAcesso !== 'FREE') {
      session.stage = 'competitions';
      this.sessions.delete(session.telegramUserId);
      return this.main('A competição deixou de estar disponível para participação gratuita. Consulte novamente pelo menu.');
    }
    this.applyEligibility(session, eligibility);
    this.refresh(session);
    return this.renderTeams(session);
  }

  private competitionsPage(session: SelectionSession, prefix = ''): TelegramSelectionResponse {
    return this.renderCompetitionPage(session, prefix);
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
    session.maxSelectableTeams = Math.max(0, Math.min(session.allTeams.length, userSlots, participantSlots, MAX_BATCH_TEAMS));

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
    keyboard.push([{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }]);
    keyboard.push([{ text: BACK_BUTTON, callback_data: this.callbackData(session, 'back-competitions') }]);
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
    preserveConfirmationKey = false,
    allowConfirmation = true,
  ): TelegramSelectionResponse {
    session.callbackNonce = randomBytes(6).toString('base64url');
    if (!preserveConfirmationKey) {
      session.confirmationKey = allowConfirmation ? randomBytes(18).toString('base64url') : undefined;
    }
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
      inlineKeyboard: [
        ...(allowConfirmation && session.confirmationKey ? [[{
          text: '✅ Confirmar inscrição',
          callback_data: this.callbackData(session, `confirm:${session.confirmationKey}`),
        }]] : []),
        [{ text: '↩️ Voltar', callback_data: this.callbackData(session, 'edit-selection') }],
        [{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }],
        [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }],
      ],
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
    if (['previous', 'next', 'toggle-all', 'clear', 'continue', 'edit-selection', 'cancel', 'back-competitions', 'main-menu', 'my-inscriptions'].includes(action)) return action;
    if (session.stage === 'competitions' && /^select-competition:[0-9a-z]{1,8}$/.test(action)) return action;
    const confirm = /^confirm:([A-Za-z0-9_-]{24})$/.exec(action);
    if (confirm && confirm[1] === session.confirmationKey) return action;
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

  private renderCompetitionPage(session: SelectionSession, prefix = ''): TelegramSelectionResponse {
    session.page = this.validPage(session.page, session.competitions.length);
    session.callbackNonce = randomBytes(6).toString('base64url');
    const start = session.page * PAGE_SIZE;
    const pageItems = session.competitions.slice(start, start + PAGE_SIZE);
    session.competitionOptions = pageItems.map((competition, index) => ({
      button: `${start + index + 1}. ${this.truncate(competition.nome, 38)} (R${competition.rodadaInicio ?? '—'}, #${competition.id})`,
      value: competition.id,
    }));
    const keyboard: TelegramInlineButton[][] = pageItems.map((competition, index) => [{
      text: `${start + index + 1}. ${this.truncate(competition.nome, 28)} (R${competition.rodadaInicio ?? '—'})`,
      callback_data: this.callbackData(session, `select-competition:${competition.id.toString(36)}`),
    }]);
    const navigation: TelegramInlineButton[] = [];
    if (session.page > 0) navigation.push({ text: PREVIOUS_BUTTON, callback_data: this.callbackData(session, 'previous') });
    if (start + PAGE_SIZE < session.competitions.length) navigation.push({ text: '➡️ Próxima', callback_data: this.callbackData(session, 'next') });
    if (navigation.length) keyboard.push(navigation);
    keyboard.push([{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }]);
    keyboard.push([{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }]);
    return {
      text: `${prefix ? `${prefix}\n\n` : ''}⚽ Competições gratuitas abertas — escolha uma opção:\n\n${pageItems.map(item => this.formatCompetition(item)).join('\n\n')}`,
      buttons: this.legacyCompetitionButtons(session, start), inlineKeyboard: keyboard, sessionToken: session.sessionToken,
    };
  }

  private legacyCompetitionButtons(session: SelectionSession, start: number): string[][] {
    const buttons = session.competitionOptions.map(option => option.button);
    if (start > 0) buttons.push(PREVIOUS_BUTTON);
    if (start + PAGE_SIZE < session.competitions.length) buttons.push(MORE_BUTTON);
    buttons.push(CANCEL_BUTTON);
    return this.rows(buttons);
  }

  private keepReceiptSession(session: SelectionSession, idempotencyKey: string): SelectionSession {
    session.completedConfirmationCallback = this.callbackData(session, `confirm:${idempotencyKey}`);
    session.stage = 'receipt';
    session.confirmationKey = undefined;
    session.selectedTeamIds = [];
    session.callbackNonce = randomBytes(6).toString('base64url');
    this.refresh(session);
    return session;
  }

  private createReceiptSession(callback: TelegramSelectionCallback): SelectionSession {
    const session: SelectionSession = {
      telegramUserId: callback.telegramUserId, stage: 'receipt', expiresAt: Date.now() + SESSION_TTL_MS,
      competitions: [], page: 0, competitionOptions: [], allTeams: [], selectedTeamIds: [], maxSelectableTeams: 0,
      sessionToken: randomBytes(12).toString('base64url'), callbackNonce: randomBytes(6).toString('base64url'),
      chatId: callback.chatId, inlineMessageId: callback.messageId,
      completedConfirmationCallback: callback.data,
    };
    this.saveSession(session);
    return session;
  }

  private rows(buttons: string[]): string[][] {
    const rows: string[][] = [];
    for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
    return rows;
  }

  private main(text: string, buttons = [['🏆 Competições', '⚽ Participar grátis'], ['📋 Minhas inscrições', '🔗 Minha conta']]): TelegramSelectionResponse {
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
