import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CompeticaoCardDto } from '../ligas-competicoes/dto/ligas-competicoes-response.dto';
import { MinhaInscricaoDto } from '../ligas-competicoes/dto/inscricoes-competicao.dto';
import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { LotesInscricaoService } from '../ligas-competicoes/lotes-inscricao.service';
import { MeusTimesService } from '../meus-times/meus-times.service';
import { AdicionarTimeDto } from '../meus-times/dto/adicionar-time.dto';
import { CartolaService } from '../cartola/cartola.service';
import { CartolaTimePayload } from '../cartola/cartola.types';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramCompetitionsService } from './telegram-competitions.service';
import { TelegramWalletOperationView, TelegramWalletPayment, TelegramWalletService } from './telegram-wallet.service';

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 1000;
const PAGE_SIZE = 8;
const MAX_BATCH_TEAMS = 50;
const MAX_TELEGRAM_TEAM_IDS = 30;
const MAX_TEAM_ID_MESSAGE_LENGTH = 2000;
const CARTOLA_LOOKUP_CONCURRENCY = 4;
const CANCEL_BUTTON = '❌ Cancelar';
const BACK_BUTTON = '↩️ Voltar';
const PREVIOUS_BUTTON = '⬅️ Anterior';
const MORE_BUTTON = '➡️ Mais opções';
const LINK_URL = 'https://pointffc.com.br/conectar-telegram/';
const CALLBACK_PREFIX = 'pfc';
const SELECT_ALL_BUTTON = '☑️ Selecionar todos';
const DESELECT_ALL_BUTTON = '⬜ Desmarcar todos';
const HOME_BUTTON = '🏠 Menu principal';
const MY_REGISTRATIONS_BUTTON = '📋 Minhas inscrições';

type SelectionStage = 'competitions' | 'participation-offer' | 'teams' | 'summary' | 'receipt' | 'registrations' | 'account'
  | 'wallet' | 'wallet-input' | 'wallet-confirmation' | 'wallet-charge'
  | 'team-registration-input' | 'team-registration-preview' | 'team-registration-result'
  | 'team-registration-bulk-input' | 'team-registration-bulk-preview'
  | 'team-registration-bulk-processing' | 'team-registration-bulk-result'
  | 'direct-enrollment-input' | 'direct-enrollment-preview' | 'direct-enrollment-register-confirm'
  | 'direct-enrollment-processing';
interface Option<T> { button: string; value: T }
interface CartolaTeamRegistration {
  timeId: number;
  nome: string;
  nomeCartola?: string;
  slug?: string;
  urlEscudoPng?: string;
  fotoPerfil?: string;
  assinante?: boolean;
}
type BulkCandidateStatus = 'available' | 'own' | 'other' | 'not-found' | 'temporary';
interface BulkTeamCandidate {
  timeId: number;
  status: BulkCandidateStatus;
  team?: CartolaTeamRegistration;
}
type DirectCandidateStatus = 'owned' | 'needs-registration' | 'already-enrolled' | 'other' | 'not-found' | 'temporary' | 'limit';
interface DirectTeamCandidate { timeId: number; status: DirectCandidateStatus; team?: CartolaTeamRegistration }
interface BulkRegistrationSummary {
  total: number;
  added: number[];
  alreadyOwn: number[];
  unavailable: number[];
  notFound: number[];
  pending: number[];
}
type TelegramRegistration = { id: number; timeIdCartola: number; nomeTime: string; competitionName: string; round: string; competitionEnd: string | null };
interface EligibilitySnapshot {
  competition: CompeticaoCardDto | null;
  registrations: MinhaInscricaoDto[];
  teams: Array<{ timeId: number; nome: string }>;
  ownedTeamCount: number;
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
  ownedTeamCount?: number;
  candidateTeam?: CartolaTeamRegistration;
  bulkCandidates?: BulkTeamCandidate[];
  bulkResult?: BulkRegistrationSummary;
  registrationOrigin?: 'account' | 'competition';
  directCandidates?: DirectTeamCandidate[];
  directSubmittedIds?: number[];
  directTeamIds?: number[];
  directAlreadyEnrolledIds?: number[];
  enrollmentTeamIds?: number[];
  enrollmentMode?: 'manual' | 'direct';
  walletRequestId?: string;
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
  copyText?: string;
  qrCodeBase64?: string;
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
    private readonly cartola: CartolaService,
    private readonly wallet: TelegramWalletService,
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

  async startAccountTeamManagement(telegramUserId: string): Promise<TelegramSelectionResponse> {
    this.sessions.delete(telegramUserId);
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(telegramUserId); } catch {
      return this.main('Não foi possível verificar seu vínculo agora. Tente novamente em instantes.');
    }
    if (usuarioId === null) return this.main(`Para gerenciar seus times, conecte sua conta POINT FFC primeiro:\n${LINK_URL}`);
    const session: SelectionSession = {
      telegramUserId, stage: 'account', expiresAt: Date.now() + SESSION_TTL_MS, competitions: [], page: 0,
      competitionOptions: [], allTeams: [], selectedTeamIds: [], maxSelectableTeams: 0,
      sessionToken: randomBytes(12).toString('base64url'), callbackNonce: '', linkedUsuarioId: usuarioId,
    };
    this.saveSession(session);
    return this.renderAccountTeamManagement(session);
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
          text: 'Sua seleção expirou. Toque em “🏆 Competições” para começar novamente.',
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
      if (session.stage === 'participation-offer') {
        if (action === 'participate-selected') return this.enterSelectedCompetition(session);
        if (action === 'back-to-competitions') {
          session.stage = 'competitions';
          session.competitionId = undefined;
          this.refresh(session);
          return { ...this.renderCompetitionPage(session), editMessage: true };
        }
        if (action === 'cancel') return this.endJourney(session, 'Jornada cancelada.');
        return null;
      }
      if (session.stage === 'receipt') {
        if (action === 'my-inscriptions') return this.openMyRegistrations(session);
        return null;
      }
      if (session.stage === 'account') {
        if (action === 'account-register-one') return this.beginTeamRegistration(session, 'account');
        if (action === 'account-register-bulk') return this.beginBulkTeamRegistration(session, 'account');
        if (action === 'account-wallet') return this.openWallet(session);
        return action === 'main-menu' || action === 'cancel' ? this.endJourney(session, 'Menu principal') : null;
      }
      if (session.stage === 'wallet') {
        if (action === 'wallet-add') return this.beginWalletInput(session);
        if (action === 'wallet-refresh') return this.refreshWalletBalance(session);
        if (action === 'wallet-back') return this.renderAccountTeamManagement(session, true);
        return null;
      }
      if (session.stage === 'wallet-input') {
        if (action === 'wallet-back') return this.openWallet(session);
        return null;
      }
      if (session.stage === 'wallet-confirmation') {
        if (action === 'wallet-confirm') return this.confirmWalletPix(session);
        if (action === 'wallet-edit') return this.beginWalletInput(session);
        if (action === 'wallet-abandon') return this.abandonWalletRequest(session);
        if (action === 'wallet-back') return this.openWallet(session);
        return null;
      }
      if (session.stage === 'wallet-charge') {
        if (action === 'wallet-refresh') return this.refreshWalletPayment(session);
        if (action === 'wallet-recover') return this.recoverWalletPayment(session);
        if (action === 'wallet-add') return this.beginWalletInput(session);
        if (action === 'wallet-back') return this.openWallet(session);
        return null;
      }
      if (session.stage === 'team-registration-input') {
        if (action === 'registration-back') {
          session.candidateTeam = undefined;
          if (session.registrationOrigin === 'account') return this.renderAccountTeamManagement(session, true);
          session.stage = 'teams';
          this.refresh(session);
          return { ...this.renderTeams(session), editMessage: true };
        }
        return null;
      }
      if (session.stage === 'team-registration-preview') {
        if (action === 'registration-back') {
          session.stage = 'team-registration-input';
          session.candidateTeam = undefined;
          this.refresh(session);
          return { ...this.renderTeamRegistrationPrompt(session), editMessage: true };
        }
        if (action === 'registration-confirm') return this.confirmTeamRegistration(session);
        return null;
      }
      if (session.stage === 'team-registration-result') {
        if (action === 'registration-return' || action === 'registration-participate') {
          return this.returnToCompetitionOrList(session);
        }
        if (action === 'registration-add-another') {
          return this.beginTeamRegistration(session, session.registrationOrigin ?? 'competition');
        }
        if (action === 'registration-account') return this.renderAccountTeamManagement(session, true);
        return null;
      }
      if (session.stage === 'team-registration-bulk-input') {
        if (action === 'registration-back') {
          session.bulkCandidates = undefined;
          session.bulkResult = undefined;
          if (session.registrationOrigin === 'account') return this.renderAccountTeamManagement(session, true);
          session.stage = 'teams';
          this.refresh(session);
          return { ...this.renderTeams(session), editMessage: true };
        }
        if (action === 'cancel') return this.endJourney(session, 'Jornada cancelada.');
        return null;
      }
      if (session.stage === 'team-registration-bulk-preview') {
        if (action === 'registration-bulk-edit') return this.beginBulkTeamRegistration(session);
        if (action === 'registration-bulk-confirm') return this.confirmBulkTeamRegistration(session);
        if (action === 'cancel') return this.endJourney(session, 'Jornada cancelada.');
        return null;
      }
      if (session.stage === 'team-registration-bulk-result') {
        if (action === 'registration-return' || action === 'registration-participate') {
          return this.returnToCompetitionOrList(session);
        }
        if (action === 'registration-bulk-add-another') return this.beginBulkTeamRegistration(session, session.registrationOrigin ?? 'competition');
        if (action === 'registration-account') return this.renderAccountTeamManagement(session, true);
        return null;
      }
      if (session.stage === 'team-registration-bulk-processing') return null;
      if (session.stage === 'direct-enrollment-input') {
        if (action === 'direct-back-manual') return this.returnToManualSelection(session);
        if (action === 'cancel') return this.endJourney(session, 'Jornada cancelada.');
        return null;
      }
      if (session.stage === 'direct-enrollment-preview') {
        if (action === 'direct-edit') return this.beginDirectEnrollment(session);
        if (action === 'direct-back-manual') return this.returnToManualSelection(session);
        if (action === 'direct-continue') return this.continueDirectEnrollment(session);
        if (action === 'cancel') return this.endJourney(session, 'Jornada cancelada.');
        return null;
      }
      if (session.stage === 'direct-enrollment-register-confirm') {
        if (action === 'direct-register-confirm') return this.confirmDirectTeamRegistration(session);
        if (action === 'direct-back-manual') return this.returnToManualSelection(session);
        if (action === 'cancel') return this.endJourney(session, 'Jornada cancelada.');
        return null;
      }
      if (session.stage === 'direct-enrollment-processing') return null;
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
      if (action === 'direct-enrollment' && session.stage === 'teams') return this.beginDirectEnrollment(session);
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
        if (session.enrollmentMode === 'direct') {
          session.stage = 'teams';
          session.confirmationKey = undefined;
          session.enrollmentMode = 'manual';
          session.enrollmentTeamIds = undefined;
          this.refresh(session);
          return { ...this.renderTeams(session, 'A lista por IDs foi mantida separada. Suas marcações manuais continuam selecionadas.'), editMessage: true };
        }
        session.stage = 'teams';
        session.confirmationKey = undefined;
        session.enrollmentMode = 'manual';
        session.enrollmentTeamIds = undefined;
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
    if (usuarioId === null || (session.linkedUsuarioId !== undefined && usuarioId !== session.linkedUsuarioId)) {
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
        text: 'A competição deixou de estar disponível para participação gratuita. Toque em “🏆 Competições” para consultar novamente.',
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
    session.enrollmentMode = 'manual';
    session.enrollmentTeamIds = [...session.selectedTeamIds];
    this.refresh(session);
    return { ...this.renderSummary(session, eligibility.competition), editMessage: true };
  }

  private async selectCompetition(session: SelectionSession, competitionId: number): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { ...this.renderCompetitionPage(session, 'Não foi possível verificar seu vínculo agora.'), editMessage: true };
    }
    if (usuarioId === null) return this.endJourney(session, `Para participar, conecte sua conta POINT FFC primeiro:\n${LINK_URL}`);
    try { return { ...await this.offerParticipation(session, competitionId, usuarioId), editMessage: true }; } catch {
      return { ...this.renderCompetitionPage(session, 'Não foi possível consultar seus times agora.'), editMessage: true };
    }
  }

  private async offerParticipation(
    session: SelectionSession,
    competitionId: number,
    usuarioId: number,
  ): Promise<TelegramSelectionResponse> {
    const competition = await this.competitions.buscarGratuitaElegivel(competitionId);
    if (!competition || competition.tipoAcesso !== 'FREE') {
      session.stage = 'competitions';
      session.competitionId = undefined;
      this.refresh(session);
      return this.renderCompetitionPage(session, 'Esta competição não está mais aberta para participação gratuita. Escolha outra.');
    }
    const index = session.competitions.findIndex(item => item.id === competition.id);
    if (index >= 0) session.competitions[index] = competition;
    session.competitionId = competition.id;
    session.linkedUsuarioId = usuarioId;
    session.stage = 'participation-offer';
    this.refresh(session);
    session.callbackNonce = randomBytes(6).toString('base64url');
    return {
      text: `${this.formatCompetition(competition)}\n\nDeseja participar desta competição?`,
      buttons: [],
      inlineKeyboard: [
        [{ text: '⚽ Participar', callback_data: this.callbackData(session, 'participate-selected') }],
        [{ text: '↩️ Voltar às competições', callback_data: this.callbackData(session, 'back-to-competitions') }],
      ],
      sessionToken: session.sessionToken,
    };
  }

  private async enterSelectedCompetition(session: SelectionSession): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { text: 'Não foi possível verificar seu vínculo agora. Tente novamente.', buttons: [], answerText: 'Tente novamente.' };
    }
    if (usuarioId === null || usuarioId !== session.linkedUsuarioId) {
      return this.endJourney(session, `Seu vínculo POINT FFC não está ativo. Conecte sua conta para continuar:\n${LINK_URL}`);
    }
    if (!session.competitionId) return this.renderCompetitionPage(session, 'Selecione uma competição para continuar.');
    try { return { ...await this.showTeams(session, session.competitionId, usuarioId), editMessage: true }; } catch {
      session.stage = 'competitions';
      return { ...this.renderCompetitionPage(session, 'Não foi possível consultar seus times agora. Tente novamente.'), editMessage: true };
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

  private async renderAccountTeamManagement(session: SelectionSession, editMessage = false): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível verificar seu vínculo. Tente novamente.' };
    }
    if (usuarioId === null || (session.linkedUsuarioId !== undefined && usuarioId !== session.linkedUsuarioId)) {
      this.sessions.delete(session.telegramUserId);
      return { text: `Seu vínculo não está ativo. Conecte sua conta POINT FFC:\n${LINK_URL}`, buttons: [],
        inlineKeyboard: [], sessionToken: session.sessionToken, editMessage: true, showMainMenu: true };
    }
    let count: number;
    try { count = (await this.teams.listarTimesDoUsuario(usuarioId)).length; } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível consultar seus times agora.' };
    }
    session.stage = 'account';
    session.linkedUsuarioId = usuarioId;
    this.refresh(session);
    session.callbackNonce = randomBytes(6).toString('base64url');
    return {
      text: `🔗 Sua conta POINT FFC está conectada ao Telegram.\n\n👥 Times cadastrados: ${count}\n\nGerencie seus times do Cartola.\n\nAcesse o site:\nhttps://pointffc.com.br`,
      buttons: [],
      inlineKeyboard: [
        [{ text: '💰 Minha carteira', callback_data: this.callbackData(session, 'account-wallet') }],
        [{ text: '➕ Cadastrar um time', callback_data: this.callbackData(session, 'account-register-one') }],
        [{ text: '📋 Cadastrar vários times', callback_data: this.callbackData(session, 'account-register-bulk') }],
        [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }],
      ],
      sessionToken: session.sessionToken,
      ...(editMessage ? { editMessage: true } : {}),
    };
  }

  private async openWallet(session: SelectionSession, notice = ''): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível verificar seu vínculo agora.' };
    }
    if (usuarioId === null || usuarioId !== session.linkedUsuarioId) {
      return this.endJourney(session, `Seu vínculo não está ativo. Conecte sua conta POINT FFC:\n${LINK_URL}`);
    }
    try {
      const snapshot = await this.wallet.consultar(session.telegramUserId);
      if (snapshot.usuarioId !== usuarioId) return this.endJourney(session, 'Seu vínculo mudou. Abra Minha conta novamente.');
      const operation = snapshot.operation;
      session.walletRequestId = operation?.id;
      if (operation?.confirmado) {
        if (operation.recarga) return this.renderWalletPayment(session, operation.recarga, snapshot, notice);
        session.stage = 'wallet-charge';
        this.refresh(session);
        session.callbackNonce = randomBytes(6).toString('base64url');
        return {
          text: `${notice ? `${notice}\n\n` : ''}🔄 Sua solicitação PIX foi autorizada e está pronta para recuperação segura.\n\nValor: R$ ${operation.valor}`,
          buttons: [], inlineKeyboard: [
            [{ text: '🔄 Recuperar cobrança', callback_data: this.callbackData(session, 'wallet-recover') }],
            [{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }],
          ], sessionToken: session.sessionToken, editMessage: true,
        };
      }
      if (operation) return this.renderWalletConfirmation(session, operation, 'Há uma solicitação aguardando confirmação.');
      return this.renderWalletHome(session, snapshot, notice);
    } catch {
      return { text: 'Não foi possível consultar sua carteira agora. Tente novamente.', buttons: [], answerText: 'Falha ao consultar carteira.' };
    }
  }

  private renderWalletHome(session: SelectionSession, snapshot: Awaited<ReturnType<TelegramWalletService['consultar']>>, notice = ''): TelegramSelectionResponse {
    session.stage = 'wallet';
    session.callbackNonce = randomBytes(6).toString('base64url');
    this.refresh(session);
    return {
      text: `${notice ? `${notice}\n\n` : ''}💰 Minha carteira\n\nSaldo disponível: R$ ${snapshot.saldoDisponivel}\nSaldo bloqueado: R$ ${snapshot.saldoBloqueado}\nStatus: ${snapshot.status === 'ATIVA' ? 'Ativa' : 'Bloqueada'}`,
      buttons: [], inlineKeyboard: [
        [{ text: '💰 Adicionar saldo', callback_data: this.callbackData(session, 'wallet-add') }],
        [{ text: '🔄 Atualizar saldo', callback_data: this.callbackData(session, 'wallet-refresh') }],
        [{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }],
      ], sessionToken: session.sessionToken, editMessage: true,
    };
  }

  private beginWalletInput(session: SelectionSession): TelegramSelectionResponse {
    session.stage = 'wallet-input';
    session.walletRequestId = undefined;
    this.refresh(session);
    session.callbackNonce = randomBytes(6).toString('base64url');
    return {
      text: '💰 Informe o valor que deseja adicionar em reais, por exemplo: 25,00. A cobrança só será criada após sua confirmação.',
      buttons: [], inlineKeyboard: [[{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }]],
      sessionToken: session.sessionToken, editMessage: true,
    };
  }

  private async previewWalletAmount(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
    const amount = input.replace(',', '.');
    try { this.wallet.validarValor(amount); } catch {
      this.refresh(session);
      session.callbackNonce = randomBytes(6).toString('base64url');
      return {
        text: 'Valor inválido. Informe um valor positivo em reais, com até duas casas decimais e dentro do limite permitido.\n\nExemplo: 25,00',
        buttons: [], inlineKeyboard: [[{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }]],
        sessionToken: session.sessionToken,
      };
    }
    try {
      const operation = await this.wallet.preparar(session.telegramUserId, amount);
      if (operation.usuarioId !== session.linkedUsuarioId) return this.endJourney(session, 'Seu vínculo mudou. Abra Minha conta novamente.');
      session.walletRequestId = operation.id;
      if (operation.confirmado) {
        if (operation.recarga) return this.renderWalletPayment(session, operation.recarga, await this.wallet.consultar(session.telegramUserId), 'Já existe uma cobrança de uma solicitação confirmada.');
        session.stage = 'wallet-charge';
        this.refresh(session);
        session.callbackNonce = randomBytes(6).toString('base64url');
        return {
          text: `Já existe uma solicitação confirmada para R$ ${operation.valor}. Nenhuma nova cobrança será criada.`,
          buttons: [], inlineKeyboard: [
            [{ text: '🔄 Recuperar cobrança', callback_data: this.callbackData(session, 'wallet-recover') }],
            [{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }],
          ], sessionToken: session.sessionToken,
        };
      }
      const mismatch = this.normalizeWalletAmount(amount) !== operation.valor
        ? `Já existe uma solicitação aguardando confirmação no valor de R$ ${operation.valor}. O valor enviado agora não foi usado.\n\n` : '';
      return this.renderWalletConfirmation(session, operation, `${mismatch}Confirme para gerar uma cobrança PIX.`);
    } catch {
      session.stage = 'wallet-input';
      this.refresh(session);
      session.callbackNonce = randomBytes(6).toString('base64url');
      return {
        text: 'Não foi possível preparar a recarga agora. Tente novamente em instantes.', buttons: [],
        inlineKeyboard: [[{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }]],
        sessionToken: session.sessionToken,
      };
    }
  }

  private renderWalletConfirmation(session: SelectionSession, operation: TelegramWalletOperationView, notice: string): TelegramSelectionResponse {
    session.stage = 'wallet-confirmation';
    session.walletRequestId = operation.id;
    session.callbackNonce = randomBytes(6).toString('base64url');
    this.refresh(session);
    return {
      text: `💰 Confirmar geração do PIX\n\nValor: R$ ${operation.valor}\n\n${notice}\n\nA cobrança só será solicitada após tocar em Confirmar.`,
      buttons: [], inlineKeyboard: [
        [{ text: '✅ Confirmar e gerar PIX', callback_data: this.callbackData(session, 'wallet-confirm') }],
        [{ text: '✏️ Alterar valor', callback_data: this.callbackData(session, 'wallet-edit') }],
        [{ text: '❌ Cancelar solicitação', callback_data: this.callbackData(session, 'wallet-abandon') }],
        [{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }],
      ], sessionToken: session.sessionToken,
    };
  }

  private async confirmWalletPix(session: SelectionSession): Promise<TelegramSelectionResponse> {
    if (!session.walletRequestId) return this.renderWalletHomeAfterError(session, 'A confirmação expirou. Inicie a solicitação novamente.');
    try {
      const payment = await this.wallet.confirmar(session.telegramUserId, session.walletRequestId);
      const snapshot = await this.wallet.consultar(session.telegramUserId);
      if (snapshot.usuarioId !== session.linkedUsuarioId) return this.endJourney(session, 'Seu vínculo mudou. Abra Minha conta novamente.');
      return this.renderWalletPayment(session, payment, snapshot, 'Cobrança PIX gerada. O saldo será atualizado após a confirmação do pagamento.');
    } catch {
      session.stage = 'wallet-charge';
      this.refresh(session);
      session.callbackNonce = randomBytes(6).toString('base64url');
      return {
        text: 'Não foi possível concluir a solicitação agora. A confirmação ficou registrada; use Recuperar cobrança para repetir a mesma operação com segurança.',
        buttons: [], inlineKeyboard: [
          [{ text: '🔄 Recuperar cobrança', callback_data: this.callbackData(session, 'wallet-recover') }],
          [{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }],
        ], sessionToken: session.sessionToken,
      };
    }
  }

  private recoverWalletPayment(session: SelectionSession): Promise<TelegramSelectionResponse> {
    return this.refreshWalletPayment(session);
  }

  private async refreshWalletPayment(session: SelectionSession): Promise<TelegramSelectionResponse> {
    if (!session.walletRequestId) return this.renderWalletHomeAfterError(session, 'Não há uma cobrança para consultar.');
    try {
      const payment = await this.wallet.atualizar(session.telegramUserId, session.walletRequestId);
      const snapshot = await this.wallet.consultar(session.telegramUserId);
      if (snapshot.usuarioId !== session.linkedUsuarioId) return this.endJourney(session, 'Seu vínculo mudou. Abra Minha conta novamente.');
      return this.renderWalletPayment(session, payment, snapshot, 'Status consultado no Mercado Pago.');
    } catch {
      session.stage = 'wallet-charge';
      this.refresh(session);
      session.callbackNonce = randomBytes(6).toString('base64url');
      return {
        text: 'Não foi possível consultar a cobrança agora. Nenhum crédito foi aplicado por esta ação. Tente novamente em instantes.',
        buttons: [], inlineKeyboard: [
          [{ text: '🔄 Tentar novamente', callback_data: this.callbackData(session, 'wallet-refresh') }],
          [{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }],
        ], sessionToken: session.sessionToken,
      };
    }
  }

  private renderWalletPayment(
    session: SelectionSession,
    payment: TelegramWalletPayment,
    snapshot: Awaited<ReturnType<TelegramWalletService['consultar']>>,
    notice = '',
  ): TelegramSelectionResponse {
    const pending = payment.status === 'PENDENTE' || payment.status === 'PROCESSANDO';
    session.walletRequestId = snapshot.operation?.id ?? session.walletRequestId;
    session.stage = pending ? 'wallet-charge' : 'wallet';
    session.callbackNonce = randomBytes(6).toString('base64url');
    this.refresh(session);
    const expiration = payment.expiracao
      ? `\nExpira em: ${payment.expiracao.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : '';
    const balance = `\n\nSaldo disponível: R$ ${snapshot.saldoDisponivel}\nSaldo bloqueado: R$ ${snapshot.saldoBloqueado}`;
    const settlementNotice = payment.status === 'APROVADA'
      ? '\n\nO provedor confirmou o pagamento. O saldo será atualizado pelo processamento oficial da recarga.' : '';
    const pixCopy = pending && payment.pixCopiaCola ? '\n\nO código PIX foi enviado em uma mensagem separada para facilitar a cópia.' : '';
    const qrLabel = pending && payment.qrCode ? '\nQR Code enviado em uma mensagem separada.' : '';
    const keyboard: TelegramInlineButton[][] = [[{
      text: pending ? '🔄 Consultar pagamento e saldo' : '💰 Adicionar saldo',
      callback_data: this.callbackData(session, pending ? 'wallet-refresh' : 'wallet-add'),
    }], [{ text: '↩️ Minha conta', callback_data: this.callbackData(session, 'wallet-back') }]];
    return {
      text: `💰 Recarga PIX\n\nValor: R$ ${payment.valor}\nStatus: ${this.formatWalletStatus(payment.status)}${expiration}${balance}${settlementNotice}${notice ? `\n\n${notice}` : ''}${pixCopy}${qrLabel}`,
      buttons: [], inlineKeyboard: keyboard, sessionToken: session.sessionToken, editMessage: true,
      ...(pending && payment.pixCopiaCola ? { copyText: payment.pixCopiaCola } : {}),
      ...(pending && payment.qrCode ? { qrCodeBase64: payment.qrCode } : {}),
    };
  }

  private async refreshWalletBalance(session: SelectionSession): Promise<TelegramSelectionResponse> {
    return this.openWallet(session, 'Saldo atualizado.');
  }

  private async abandonWalletRequest(session: SelectionSession): Promise<TelegramSelectionResponse> {
    if (session.walletRequestId) {
      try { await this.wallet.abandonar(session.telegramUserId, session.walletRequestId); } catch {
        return this.renderWalletHomeAfterError(session, 'A solicitação já foi confirmada ou não pode ser cancelada.');
      }
    }
    session.walletRequestId = undefined;
    return this.openWallet(session, 'Solicitação cancelada antes da geração do PIX.');
  }

  private async renderWalletHomeAfterError(session: SelectionSession, message: string): Promise<TelegramSelectionResponse> {
    try {
      const snapshot = await this.wallet.consultar(session.telegramUserId);
      if (snapshot.usuarioId !== session.linkedUsuarioId) return this.endJourney(session, 'Seu vínculo mudou. Abra Minha conta novamente.');
      session.walletRequestId = snapshot.operation?.id;
      return this.renderWalletHome(session, snapshot, message);
    } catch {
      return { text: 'Não foi possível acessar a carteira agora. Tente novamente.', buttons: [], answerText: message };
    }
  }

  private normalizeWalletAmount(value: string): string {
    const [units, cents = ''] = value.split('.');
    return `${BigInt(units)}.${cents.padEnd(2, '0')}`;
  }

  private formatWalletStatus(status: string): string {
    const labels: Record<string, string> = {
      PENDENTE: 'Aguardando pagamento', PROCESSANDO: 'Processando', APROVADA: 'Pagamento confirmado',
      REJEITADA: 'Não aprovada', CANCELADA: 'Cancelada', EXPIRADA: 'Expirada', REEMBOLSADA: 'Reembolsada',
    };
    return labels[status] ?? 'Em processamento';
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
    if (usuarioId === null || (session.linkedUsuarioId !== undefined && usuarioId !== session.linkedUsuarioId)) {
      this.sessions.delete(session.telegramUserId);
      return {
        text: `Não foi possível confirmar seu vínculo ativo. Conecte sua conta POINT FFC:\n${LINK_URL}`,
        buttons: [], sessionToken: session.sessionToken, inlineKeyboard: [], editMessage: true,
        answerText: 'Vínculo não disponível. Conecte sua conta POINT FFC.',
      };
    }

    if (session.enrollmentMode === 'direct') {
      let latest: EligibilitySnapshot;
      try { latest = await this.loadEligibility(session, usuarioId); } catch {
        return this.renderConfirmationFailure(session, competition,
          'Não foi possível revalidar a capacidade da competição. A inscrição não foi enviada; tente novamente.');
      }
      if (!latest.competition || latest.competition.tipoAcesso !== 'FREE') {
        this.sessions.delete(session.telegramUserId);
        return { text: 'A competição deixou de estar disponível para inscrição gratuita. Inicie novamente pelo menu.',
          buttons: [], sessionToken: session.sessionToken, inlineKeyboard: [], editMessage: true };
      }
      const selected = [...(session.enrollmentTeamIds ?? [])];
      const slots = this.remainingEnrollmentSlots(latest);
      if (slots < selected.length) {
        const kept = selected.slice(0, slots);
        const dropped = selected.slice(slots);
        session.directTeamIds = kept;
        session.enrollmentTeamIds = kept;
        for (const candidate of session.directCandidates ?? []) {
          if (dropped.includes(candidate.timeId)) candidate.status = 'limit';
        }
        if (!kept.length) {
          session.stage = 'direct-enrollment-preview';
          this.refresh(session);
          return { ...this.renderDirectEnrollmentPreview(session,
            `A capacidade mudou. Foram enviados ${(session.directSubmittedIds ?? []).length} IDs distintos; 0 podem ser inscritos e ${dropped.length} ficaram fora por limite (${this.formatTeamIds(dropped)}).`), editMessage: true };
        }
        session.enrollmentTeamIds = kept;
        this.refresh(session);
        return { ...this.renderDirectEnrollmentConfirmation(session, latest.competition,
          `A capacidade mudou. Foram enviados ${(session.directSubmittedIds ?? []).length} IDs distintos; ${kept.length} podem ser inscritos e ${dropped.length} ficaram fora por limite (${this.formatTeamIds(dropped)}). Revise e confirme novamente.`), editMessage: true };
      }
    }

    try {
      await this.enrollmentBatches.criarFree(session.competitionId, usuarioId, {
        timesCartolaIds: session.enrollmentMode === 'direct'
          ? [...(session.enrollmentTeamIds ?? session.selectedTeamIds)]
          : [...(session.enrollmentTeamIds ?? session.selectedTeamIds)].sort((a, b) => a - b),
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
    if (session.enrollmentMode === 'direct') {
      return { ...this.renderDirectEnrollmentConfirmation(session, competition, notice), editMessage: true };
    }
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
    const previous = session.enrollmentMode === 'direct' && (session.directAlreadyEnrolledIds?.length ?? 0) > 0
      ? `\nJá inscritos anteriormente nesta competição: ${session.directAlreadyEnrolledIds!.length}\n` : '';
    const header = `🏆 Inscrição realizada com sucesso!\n\nCompetição: ${this.truncate(confirmed.competenciaNome, 180)}${previous}\n\n`;
    const footer = `\n\nTotal: ${confirmed.resposta.quantidade} ${confirmed.resposta.quantidade === 1 ? 'time' : 'times'}\nValor: R$ 0,00`;
    const selectedLines = confirmed.times.map(time => `• ${this.truncate(time.nomeTime, 200)} (#${time.timeIdCartola})`);
    const priorNames = new Map((session.directCandidates ?? []).map(item => [item.timeId, item.team?.nome]));
    const previousLines = (session.enrollmentMode === 'direct' ? session.directAlreadyEnrolledIds ?? [] : [])
      .map(id => `• ${this.truncate(priorNames.get(id) ?? `Time ${id}`, 100)} (#${id})`);
    const receiptLines = [...(previousLines.length ? ['Já inscritos anteriormente:', ...previousLines, ''] : []), 'Times inscritos:', ...selectedLines];
    const visible: string[] = [];
    const overflow: string[] = [];
    for (const line of receiptLines) {
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
        ? this.main('Sua seleção expirou ou foi reiniciada. Toque em “🏆 Competições” para começar novamente.')
        : null;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(telegramUserId);
      return this.main('Sua seleção expirou. Toque em “🏆 Competições” para começar novamente.');
    }

    const input = text.trim();
    if (input === CANCEL_BUTTON) {
      this.sessions.delete(telegramUserId);
      return this.main('Jornada cancelada.');
    }

    if (session.stage === 'team-registration-input') return this.previewCartolaTeam(session, input);
    if (session.stage === 'team-registration-bulk-input') return this.previewCartolaTeams(session, input);
    if (session.stage === 'direct-enrollment-input') return this.previewDirectEnrollment(session, input);
    if (session.stage === 'wallet-input') return this.previewWalletAmount(session, input);
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
      return await this.offerParticipation(session, option.value, usuarioId);
    } catch {
      return this.main('Não foi possível consultar seus times agora. Tente iniciar a jornada novamente em instantes.');
    }
  }

  private beginTeamRegistration(session: SelectionSession, origin: 'account' | 'competition' = 'competition'): TelegramSelectionResponse {
    session.registrationOrigin = origin;
    session.stage = 'team-registration-input';
    session.candidateTeam = undefined;
    session.bulkCandidates = undefined;
    session.bulkResult = undefined;
    this.refresh(session);
    return { ...this.renderTeamRegistrationPrompt(session), editMessage: true };
  }

  private renderTeamRegistrationPrompt(session: SelectionSession, notice = ''): TelegramSelectionResponse {
    session.callbackNonce = randomBytes(6).toString('base64url');
    return {
      text: `${notice ? `${notice}\n\n` : ''}🔎 Envie o ID do seu time no Cartola.\n\nExemplo: 13933388`,
      buttons: [],
      inlineKeyboard: [
        [{ text: '↩️ Voltar', callback_data: this.callbackData(session, 'registration-back') }],
        [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }],
        [{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }],
      ],
      sessionToken: session.sessionToken,
    };
  }

  private async previewCartolaTeam(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
    if (!/^\d{1,10}$/.test(input)) {
      this.refresh(session);
      return this.renderTeamRegistrationPrompt(session, 'Envie somente um ID numérico do Cartola, sem espaços ou lista.');
    }
    const timeId = Number(input);
    if (!Number.isSafeInteger(timeId) || timeId < 1 || timeId > 4_294_967_295) {
      this.refresh(session);
      return this.renderTeamRegistrationPrompt(session, 'Esse ID está fora do intervalo aceito. Envie um ID numérico válido.');
    }

    let candidate: CartolaTeamRegistration;
    try {
      const result = await this.cartola.getTeamById(timeId);
      candidate = this.mapCartolaTeam(timeId, result.value);
    } catch (error) {
      this.refresh(session);
      if (error instanceof NotFoundException) {
        return this.renderTeamRegistrationPrompt(session, 'Não encontramos esse time no Cartola. Confira o ID e tente novamente.');
      }
      return this.renderTeamRegistrationPrompt(session, 'Não foi possível consultar o Cartola agora. Tente novamente em instantes.');
    }

    session.candidateTeam = candidate;
    session.stage = 'team-registration-preview';
    this.refresh(session);
    return this.renderTeamRegistrationPreview(session);
  }

  private mapCartolaTeam(timeId: number, payload: CartolaTimePayload): CartolaTeamRegistration {
    const nested = this.isRecord(payload.time) ? payload.time as CartolaTimePayload : undefined;
    const source = nested ?? payload;
    const officialId = typeof source.time_id === 'number' ? source.time_id
      : typeof payload.time_id === 'number' ? payload.time_id : timeId;
    const nome = typeof source.nome === 'string' ? source.nome.trim()
      : typeof payload.nome === 'string' ? payload.nome.trim() : '';
    if (officialId !== timeId || !nome) throw new NotFoundException('Time do Cartola sem dados públicos válidos');
    const nomeCartola = this.stringField(source.nome_cartola) ?? this.stringField(source.cartoleiro_nome)
      ?? this.stringField(payload.nome_cartola) ?? this.stringField(payload.cartoleiro_nome);
    const urlEscudoPng = this.safeHttpUrl(this.stringField(source.url_escudo_png)
      ?? this.stringField(payload.url_escudo_png));
    const fotoPerfil = this.safeHttpUrl(this.stringField(source.foto_perfil) ?? this.stringField(payload.foto_perfil));
    const slug = this.stringField(source.slug) ?? this.stringField(payload.slug);
    const assinante = typeof source.assinante === 'boolean' ? source.assinante
      : typeof payload.assinante === 'boolean' ? payload.assinante : undefined;
    return { timeId, nome, ...(nomeCartola ? { nomeCartola } : {}), ...(slug ? { slug } : {}),
      ...(urlEscudoPng ? { urlEscudoPng } : {}), ...(fotoPerfil ? { fotoPerfil } : {}),
      ...(assinante !== undefined ? { assinante } : {}) };
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private safeHttpUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined;
    } catch { return undefined; }
  }

  private renderTeamRegistrationPreview(session: SelectionSession, notice = ''): TelegramSelectionResponse {
    const team = session.candidateTeam;
    session.callbackNonce = randomBytes(6).toString('base64url');
    if (!team) return this.renderTeamRegistrationPrompt(session, 'Não foi possível carregar os dados do time. Envie o ID novamente.');
    return {
      text: `${notice ? `${notice}\n\n` : ''}🔎 Time encontrado!\n\n⚽ ${this.truncate(team.nome, 150)}\n🆔 ${team.timeId}\n\nDeseja adicionar este time ao seu perfil POINT FFC?`,
      buttons: [],
      inlineKeyboard: [
        [{ text: '✅ Adicionar ao meu perfil', callback_data: this.callbackData(session, 'registration-confirm') }],
        [{ text: '↩️ Voltar', callback_data: this.callbackData(session, 'registration-back') }],
        [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }],
        [{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }],
      ],
      sessionToken: session.sessionToken,
    };
  }

  private async confirmTeamRegistration(session: SelectionSession): Promise<TelegramSelectionResponse> {
    const candidate = session.candidateTeam;
    if (!candidate) {
      session.stage = 'team-registration-input';
      this.refresh(session);
      return { ...this.renderTeamRegistrationPrompt(session, 'A prévia expirou. Envie novamente o ID do time.'), editMessage: true };
    }
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível validar sua conta POINT FFC. Tente novamente.' };
    }
    if (usuarioId === null || (session.linkedUsuarioId !== undefined && usuarioId !== session.linkedUsuarioId)) {
      this.sessions.delete(session.telegramUserId);
      return { text: 'Seu vínculo POINT FFC não está ativo. Conecte sua conta novamente para cadastrar um time.',
        buttons: [], inlineKeyboard: [], sessionToken: session.sessionToken, editMessage: true,
        answerText: 'Vínculo não ativo. Conecte sua conta e inicie novamente.' };
    }

    let freshTeam: CartolaTeamRegistration;
    try {
      const result = await this.cartola.getTeamById(candidate.timeId, { forceRefresh: true });
      freshTeam = this.mapCartolaTeam(candidate.timeId, result.value);
    } catch (error) {
      if (error instanceof NotFoundException) {
        session.stage = 'team-registration-input';
        session.candidateTeam = undefined;
        this.refresh(session);
        return { ...this.renderTeamRegistrationPrompt(session, 'O time não está mais disponível no Cartola. Confira o ID e tente novamente.'), editMessage: true };
      }
      return { text: '', buttons: [], answerText: 'Não foi possível revalidar o time agora. Tente novamente em instantes.' };
    }

    const dto: AdicionarTimeDto = {
      timeId: freshTeam.timeId, nome: freshTeam.nome,
      ...(freshTeam.nomeCartola ? { nomeCartola: freshTeam.nomeCartola } : {}),
      ...(freshTeam.slug ? { slug: freshTeam.slug } : {}),
      ...(freshTeam.urlEscudoPng ? { urlEscudoPng: freshTeam.urlEscudoPng } : {}),
      ...(freshTeam.fotoPerfil ? { fotoPerfil: freshTeam.fotoPerfil } : {}),
      ...(freshTeam.assinante !== undefined ? { assinante: freshTeam.assinante } : {}),
    };
    try {
      const result = await this.teams.adicionarTime(usuarioId, dto);
      if (result.status === 'ja_existente') {
        const alreadyOwns = await this.teams.buscarTimeDoUsuario(usuarioId, candidate.timeId);
        if (!alreadyOwns) {
          session.stage = 'teams';
          session.candidateTeam = undefined;
          this.refresh(session);
          return { ...this.renderTeams(session, 'Este time não pode ser associado ao seu perfil.'), editMessage: true };
        }
        session.stage = 'team-registration-result';
        session.candidateTeam = freshTeam;
        this.refresh(session);
        return { ...this.renderTeamRegistrationResult(session, '', true), editMessage: true };
      }
    } catch {
      // A resposta do MySQL pode ser incerta após o commit. Confirmar estado persistido
      // antes de orientar qualquer repetição; não executar uma segunda escrita aqui.
      try {
        const persisted = await this.teams.buscarTimeDoUsuario(usuarioId, candidate.timeId);
        if (!persisted) return { text: '', buttons: [], answerText: 'Não foi possível confirmar o cadastro do time. Consulte seus times antes de tentar novamente.' };
      } catch {
        return { text: '', buttons: [], answerText: 'Não foi possível confirmar o cadastro do time. Consulte seus times antes de tentar novamente.' };
      }
    }
    session.stage = 'team-registration-result';
    session.candidateTeam = freshTeam;
    session.linkedUsuarioId = usuarioId;
    this.refresh(session);
    return { ...this.renderTeamRegistrationResult(session), editMessage: true };
  }

  private renderTeamRegistrationResult(session: SelectionSession, notice = '', alreadyExists = false): TelegramSelectionResponse {
    const team = session.candidateTeam;
    session.callbackNonce = randomBytes(6).toString('base64url');
    return {
      text: `${notice ? `${notice}\n\n` : ''}${alreadyExists ? 'ℹ️ Este time já está cadastrado no seu perfil.' : '✅ Time adicionado ao seu perfil!'}\n\n⚽ ${this.truncate(team?.nome ?? 'Time Cartola', 150)}\n🆔 ${team?.timeId ?? '—'}\n\nAgora você pode participar das competições do POINT FFC.`,
      buttons: [],
      inlineKeyboard: [
        ...(session.registrationOrigin === 'account'
          ? [[{ text: '⚽ Participar', callback_data: this.callbackData(session, 'registration-participate') }],
            [{ text: '🔗 Minha conta', callback_data: this.callbackData(session, 'registration-account') }]]
          : [[{ text: session.competitionId ? '⚽ Voltar à competição' : '⚽ Inscrever em competição', callback_data: this.callbackData(session, 'registration-participate') }]]),
        [{ text: session.registrationOrigin === 'account' ? '➕ Cadastrar um time' : '➕ Adicionar outro time', callback_data: this.callbackData(session, 'registration-add-another') }],
        [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }],
      ],
      sessionToken: session.sessionToken,
    };
  }

  private beginBulkTeamRegistration(session: SelectionSession, origin: 'account' | 'competition' = 'competition'): TelegramSelectionResponse {
    session.registrationOrigin = origin;
    session.stage = 'team-registration-bulk-input';
    session.candidateTeam = undefined;
    session.bulkCandidates = undefined;
    session.bulkResult = undefined;
    this.refresh(session);
    return { ...this.renderBulkTeamRegistrationPrompt(session), editMessage: true };
  }

  private beginDirectEnrollment(session: SelectionSession): TelegramSelectionResponse {
    session.directCandidates = undefined;
    session.directSubmittedIds = undefined;
    session.directTeamIds = undefined;
    session.directAlreadyEnrolledIds = undefined;
    session.stage = 'direct-enrollment-input';
    this.refresh(session);
    session.callbackNonce = randomBytes(6).toString('base64url');
    const manualCount = session.selectedTeamIds.length;
    return {
      text: `📋 Inscrição por lista de IDs\n\nEnvie os IDs dos times do Cartola que deseja inscrever nesta competição.\n\nSepare por linha, espaço, vírgula ou ponto e vírgula.\n\nExemplo:\n\n13933388\n25903156\n29550505\n\nMáximo: 30 IDs distintos por envio.${manualCount ? `\n\nVocê tem ${manualCount} time(s) marcado(s) na seleção manual. A lista será uma seleção própria e não será combinada com essas marcações.` : ''}`,
      buttons: [],
      inlineKeyboard: [
        [{ text: '↩️ Voltar à seleção manual', callback_data: this.callbackData(session, 'direct-back-manual') }],
      ],
      sessionToken: session.sessionToken,
      editMessage: true,
    };
  }

  private async previewDirectEnrollment(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
    const parsed = this.parseBulkTeamIds(input);
    if (!parsed.ids) return this.renderDirectEnrollmentInput(session, parsed.error);
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return this.renderDirectEnrollmentInput(session, 'Não foi possível verificar seu vínculo agora. Tente novamente.');
    }
    if (usuarioId === null || usuarioId !== session.linkedUsuarioId) {
      this.sessions.delete(session.telegramUserId);
      return this.main(`Seu vínculo POINT FFC não está ativo. Conecte sua conta para continuar:\n${LINK_URL}`);
    }
    let snapshot: EligibilitySnapshot;
    try { snapshot = await this.loadEligibility(session, usuarioId); } catch {
      return this.renderDirectEnrollmentInput(session, 'Não foi possível revalidar a competição e os times. Tente novamente.');
    }
    if (!snapshot.competition || snapshot.competition.tipoAcesso !== 'FREE') {
      this.sessions.delete(session.telegramUserId);
      return this.main('A competição não está mais disponível para inscrição gratuita. Toque em “🏆 Competições” para escolher outra.');
    }
    let associations: Array<{ timeId: number; status: 'proprio' | 'outro' | 'disponivel' }>;
    try { associations = await this.teams.consultarStatusAssociacaoTimes(usuarioId, parsed.ids); } catch {
      return this.renderDirectEnrollmentInput(session, 'Não foi possível consultar as associações dos times agora. Tente novamente.');
    }
    const associationById = new Map(associations.map(item => [item.timeId, item.status]));
    const registeredIds = new Set(snapshot.registrations.map(item => item.timeIdCartola));
    const registeredNames = new Map(snapshot.teams.map(team => [team.timeId, team.nome]));
    const candidates = await this.mapWithConcurrency(parsed.ids, CARTOLA_LOOKUP_CONCURRENCY, async (timeId): Promise<DirectTeamCandidate> => {
      if (registeredIds.has(timeId)) return { timeId, status: 'already-enrolled',
        ...(registeredNames.has(timeId) ? { team: { timeId, nome: registeredNames.get(timeId)! } } : {}) };
      const association = associationById.get(timeId);
      if (association === 'outro') return { timeId, status: 'other' };
      if (association === 'proprio') {
        try {
          const officialTeam = this.mapCartolaTeam(timeId, (await this.cartola.getTeamById(timeId)).value);
          return { timeId, status: 'owned', team: officialTeam };
        } catch (error) {
          return { timeId, status: error instanceof NotFoundException ? 'not-found' : 'temporary' };
        }
      }
      try {
        const team = this.mapCartolaTeam(timeId, (await this.cartola.getTeamById(timeId)).value);
        return { timeId, status: 'needs-registration', team };
      } catch (error) {
        return { timeId, status: error instanceof NotFoundException ? 'not-found' : 'temporary' };
      }
    });
    const slots = this.remainingEnrollmentSlots(snapshot);
    const eligible = candidates.filter(item => item.status === 'owned' || item.status === 'needs-registration');
    for (const item of eligible.slice(slots)) item.status = 'limit';
    session.directCandidates = candidates;
    session.directSubmittedIds = [...parsed.ids];
    session.directTeamIds = eligible.slice(0, slots).map(item => item.timeId);
    session.directAlreadyEnrolledIds = candidates.filter(item => item.status === 'already-enrolled').map(item => item.timeId);
    session.stage = 'direct-enrollment-preview';
    this.refresh(session);
    return this.renderDirectEnrollmentPreview(session);
  }

  private remainingEnrollmentSlots(snapshot: EligibilitySnapshot): number {
    const competition = snapshot.competition;
    if (!competition) return 0;
    const activeUserCount = snapshot.registrations.filter(row => row.statusInscricao === 'ATIVA').length;
    const userSlots = competition.limiteTimesUsuario === null
      ? Number.MAX_SAFE_INTEGER : Math.max(0, competition.limiteTimesUsuario - activeUserCount);
    const participantSlots = competition.limiteParticipantes === null
      ? Number.MAX_SAFE_INTEGER : Math.max(0, competition.limiteParticipantes - snapshot.activeParticipants);
    return Math.max(0, Math.min(userSlots, participantSlots));
  }

  private renderDirectEnrollmentInput(session: SelectionSession, notice = ''): TelegramSelectionResponse {
    session.stage = 'direct-enrollment-input';
    this.refresh(session);
    session.callbackNonce = randomBytes(6).toString('base64url');
    return {
      text: `${notice ? `${notice}\n\n` : ''}📋 Inscrição por lista de IDs\n\nEnvie os IDs dos times do Cartola que deseja inscrever nesta competição.\n\nSepare por linha, espaço, vírgula ou ponto e vírgula.\n\nMáximo: 30 IDs distintos por envio.`,
      buttons: [],
      inlineKeyboard: [[{ text: '↩️ Voltar à seleção manual', callback_data: this.callbackData(session, 'direct-back-manual') }]],
      sessionToken: session.sessionToken,
      editMessage: true,
    };
  }

  private renderDirectEnrollmentPreview(session: SelectionSession, notice = ''): TelegramSelectionResponse {
    const candidates = session.directCandidates ?? [];
    const selected = new Set(session.directTeamIds ?? []);
    const limited = candidates.filter(item => item.status === 'limit');
    const group = (status: DirectCandidateStatus) => candidates.filter(item => item.status === status);
    const lines = [
      `${notice ? `${notice}\n\n` : ''}📋 Prévia da inscrição`,
      '',
      `Competição: ${this.truncate(session.competitions.find(item => item.id === session.competitionId)?.nome ?? 'Competição FREE', 130)}`,
      '',
      `✅ Já no seu perfil: ${group('owned').filter(item => selected.has(item.timeId)).length}`,
      `➕ Precisam ser cadastrados: ${group('needs-registration').filter(item => selected.has(item.timeId)).length}`,
      `ℹ️ Já inscritos nesta competição: ${group('already-enrolled').length}`,
      `⚠️ Associados a outro perfil ou indisponíveis: ${group('other').length}`,
      `❌ Não encontrados: ${group('not-found').length}`,
      `⏳ Consulta temporariamente indisponível: ${group('temporary').length}`,
      `📨 IDs distintos enviados: ${(session.directSubmittedIds ?? candidates.map(item => item.timeId)).length}`,
      `✅ Podem ser inscritos: ${selected.size}`,
      `🚫 Fora por limite: ${limited.length}`,
      '',
      `Times elegíveis para nova inscrição: ${selected.size}`,
    ];
    const selectedCandidates = candidates.filter(item => selected.has(item.timeId));
    if (selectedCandidates.length) {
      lines.push('', 'Times elegíveis:');
      selectedCandidates.forEach((item, index) => lines.push(`${index + 1}. ${this.truncate(item.team?.nome ?? `Time ${item.timeId}`, 45)} — #${item.timeId}`));
    }
    const alreadyEnrolled = group('already-enrolled');
    if (alreadyEnrolled.length) {
      lines.push('', 'Já inscritos nesta competição:');
      alreadyEnrolled.forEach(item => lines.push(`• ${this.truncate(item.team?.nome ?? `Time ${item.timeId}`, 45)} — #${item.timeId}`));
    }
    const rejected = candidates.filter(item => ['other', 'not-found', 'temporary', 'already-enrolled'].includes(item.status));
    if (rejected.length) lines.push('', `IDs não incluídos: ${this.formatTeamIds(rejected.map(item => item.timeId))}`);
    if (limited.length) lines.push('', `IDs fora por limite: ${this.formatTeamIds(limited.map(item => item.timeId))}`);
    session.callbackNonce = randomBytes(6).toString('base64url');
    const keyboard: TelegramInlineButton[][] = [];
    if (selected.size) keyboard.push([{ text: '➡️ Continuar', callback_data: this.callbackData(session, 'direct-continue') }]);
    keyboard.push([{ text: '✏️ Enviar outra lista', callback_data: this.callbackData(session, 'direct-edit') }]);
    keyboard.push([{ text: '↩️ Voltar à seleção manual', callback_data: this.callbackData(session, 'direct-back-manual') }]);
    return { text: lines.join('\n').slice(0, 3900), buttons: [], inlineKeyboard: keyboard, sessionToken: session.sessionToken };
  }

  private async continueDirectEnrollment(session: SelectionSession): Promise<TelegramSelectionResponse> {
    const ids = session.directTeamIds ?? [];
    if (!ids.length) return { ...this.renderDirectEnrollmentPreview(session, 'Nenhum time está elegível para nova inscrição.'), editMessage: true };
    const needsRegistration = (session.directCandidates ?? []).filter(item => ids.includes(item.timeId) && item.status === 'needs-registration');
    if (needsRegistration.length) {
      session.stage = 'direct-enrollment-register-confirm';
      this.refresh(session);
      session.callbackNonce = randomBytes(6).toString('base64url');
      return {
        text: `➕ ${needsRegistration.length} ${needsRegistration.length === 1 ? 'time precisa' : 'times precisam'} ser adicionados ao seu perfil POINT FFC antes da inscrição.\n\nDeseja cadastrar esses times e continuar?\n\nO cadastro não realiza a inscrição.`,
        buttons: [],
        inlineKeyboard: [
          [{ text: '✅ Cadastrar e continuar', callback_data: this.callbackData(session, 'direct-register-confirm') }],
          [{ text: '↩️ Voltar à seleção manual', callback_data: this.callbackData(session, 'direct-back-manual') }],
        ],
        sessionToken: session.sessionToken,
        editMessage: true,
      };
    }
    return this.prepareDirectEnrollmentConfirmation(session);
  }

  private async confirmDirectTeamRegistration(session: SelectionSession): Promise<TelegramSelectionResponse> {
    session.stage = 'direct-enrollment-processing';
    session.callbackNonce = randomBytes(6).toString('base64url');
    this.refresh(session);
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      session.stage = 'direct-enrollment-preview';
      return { ...this.renderDirectEnrollmentPreview(session, 'Não foi possível confirmar seu vínculo. Nenhum cadastro foi iniciado.'), editMessage: true };
    }
    if (usuarioId === null || usuarioId !== session.linkedUsuarioId) {
      this.sessions.delete(session.telegramUserId);
      return { text: `Seu vínculo POINT FFC não está ativo. Conecte sua conta:\n${LINK_URL}`, buttons: [], inlineKeyboard: [], sessionToken: session.sessionToken, editMessage: true, showMainMenu: true };
    }
    let latest: EligibilitySnapshot;
    try { latest = await this.loadEligibility(session, usuarioId); } catch {
      session.stage = 'direct-enrollment-preview';
      return { ...this.renderDirectEnrollmentPreview(session, 'Não foi possível revalidar a capacidade. Nenhum time foi cadastrado.'), editMessage: true };
    }
    if (!latest.competition || latest.competition.tipoAcesso !== 'FREE') {
      session.stage = 'direct-enrollment-preview';
      return { ...this.renderDirectEnrollmentPreview(session, 'A competição deixou de estar disponível como FREE. Nenhum time foi cadastrado.'), editMessage: true };
    }
    const selectedIds = [...(session.directTeamIds ?? [])];
    const alreadyRegistered = new Set(latest.registrations.map(row => row.timeIdCartola));
    const slots = this.remainingEnrollmentSlots(latest);
    const stillEligible = selectedIds.filter(id => !alreadyRegistered.has(id));
    const allowed = stillEligible.slice(0, slots);
    const dropped = stillEligible.slice(slots);
    const newlyRegistered = selectedIds.filter(id => alreadyRegistered.has(id));
    if (dropped.length || newlyRegistered.length) {
      session.directTeamIds = allowed;
      session.directAlreadyEnrolledIds = [...new Set([...(session.directAlreadyEnrolledIds ?? []), ...newlyRegistered])];
      for (const candidate of session.directCandidates ?? []) {
        if (alreadyRegistered.has(candidate.timeId)) candidate.status = 'already-enrolled';
        else if (dropped.includes(candidate.timeId)) candidate.status = 'limit';
      }
      session.stage = 'direct-enrollment-preview';
      this.refresh(session);
      const note = `A elegibilidade mudou antes do cadastro. Foram enviados ${(session.directSubmittedIds ?? []).length} IDs distintos; ${allowed.length} podem seguir e ${dropped.length} ficaram fora por limite${dropped.length ? ` (${this.formatTeamIds(dropped)})` : ''}. Nenhum cadastro foi feito nesta tentativa.`;
      return { ...this.renderDirectEnrollmentPreview(session, note), editMessage: true };
    }
    const requested = (session.directCandidates ?? []).filter(item => (session.directTeamIds ?? []).includes(item.timeId) && item.status === 'needs-registration');
    let statuses: Array<{ timeId: number; status: 'proprio' | 'outro' | 'disponivel' }>;
    try { statuses = await this.teams.consultarStatusAssociacaoTimes(usuarioId, requested.map(item => item.timeId)); }
    catch {
      session.stage = 'direct-enrollment-preview';
      return { ...this.renderDirectEnrollmentPreview(session, 'Não foi possível revalidar as associações. Nenhum cadastro foi iniciado.'), editMessage: true };
    }
    const statusById = new Map(statuses.map(item => [item.timeId, item.status]));
    const refreshed = await this.mapWithConcurrency(requested, CARTOLA_LOOKUP_CONCURRENCY, async candidate => {
      if (statusById.get(candidate.timeId) !== 'disponivel') return null;
      try { return this.teamRegistrationDto(this.mapCartolaTeam(candidate.timeId, (await this.cartola.getTeamById(candidate.timeId, { forceRefresh: true })).value)); }
      catch { return null; }
    });
    const toRegister = refreshed.filter((item): item is AdicionarTimeDto => item !== null);
    let serviceAdded = new Set<number>();
    if (toRegister.length) {
      try {
        const result = await this.teams.adicionarTimesEmLote(usuarioId, toRegister);
        serviceAdded = new Set(result.timesAdicionados);
      } catch { /* Resolve the persisted result below; never retry an uncertain batch. */ }
    }
    let persisted: Array<{ timeId: number; status: 'proprio' | 'outro' | 'disponivel' }> = [];
    try { persisted = await this.teams.consultarStatusAssociacaoTimes(usuarioId, requested.map(item => item.timeId)); } catch { /* show pending below */ }
    const persistedById = new Map(persisted.map(item => [item.timeId, item.status]));
    const nowOwned = new Set(persisted.filter(item => item.status === 'proprio').map(item => item.timeId));
    const registeredToProfile = new Set([...serviceAdded, ...nowOwned]);
    const nowUnavailable = requested.filter(item => persistedById.get(item.timeId) === 'outro').map(item => item.timeId);
    const pending = requested.filter(item => !['proprio', 'outro'].includes(persistedById.get(item.timeId) ?? '')).map(item => item.timeId);
    const notice = `${registeredToProfile.size} time(s) confirmado(s) no perfil.${nowUnavailable.length ? ` Indisponíveis: ${this.formatTeamIds(nowUnavailable)}.` : ''}${pending.length ? ` Pendentes: ${this.formatTeamIds(pending)}; confira o perfil antes de tentar novamente.` : ''}`;
    return this.prepareDirectEnrollmentConfirmation(session, notice);
  }

  private async prepareDirectEnrollmentConfirmation(session: SelectionSession, notice = ''): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { ...this.renderDirectEnrollmentPreview(session, 'Não foi possível revalidar seu vínculo. Tente novamente.'), editMessage: true };
    }
    if (usuarioId === null || usuarioId !== session.linkedUsuarioId) {
      this.sessions.delete(session.telegramUserId);
      return this.main(`Seu vínculo POINT FFC não está ativo. Conecte sua conta:\n${LINK_URL}`);
    }
    let snapshot: EligibilitySnapshot;
    try { snapshot = await this.loadEligibility(session, usuarioId); } catch {
      return { ...this.renderDirectEnrollmentPreview(session, 'Não foi possível revalidar a elegibilidade. Tente novamente.'), editMessage: true };
    }
    if (!snapshot.competition || snapshot.competition.tipoAcesso !== 'FREE') {
      this.sessions.delete(session.telegramUserId);
      return this.main('A competição deixou de estar disponível como FREE. Escolha outra competição gratuita.');
    }
    const manual = [...session.selectedTeamIds];
    const alreadyRegistered = new Set(snapshot.registrations.map(item => item.timeIdCartola));
    this.applyEligibility(session, snapshot);
    session.selectedTeamIds = manual.filter(id => session.allTeams.some(team => team.id === id));
    const ownedEligible = new Set(session.allTeams.map(team => team.id));
    const originalIds = [...new Set(session.directTeamIds ?? [])];
    const candidates = session.directCandidates ?? [];
    for (const candidate of candidates) {
      if (alreadyRegistered.has(candidate.timeId)) candidate.status = 'already-enrolled';
      else if (ownedEligible.has(candidate.timeId)) candidate.status = 'owned';
    }
    const requested = originalIds.filter(id => ownedEligible.has(id));
    const valid = requested.slice(0, session.maxSelectableTeams);
    const dropped = originalIds.filter(id => !valid.includes(id));
    session.directTeamIds = valid;
    session.directAlreadyEnrolledIds = [...new Set(candidates.filter(item => item.status === 'already-enrolled').map(item => item.timeId))];
    for (const candidate of candidates) {
      if (dropped.includes(candidate.timeId) && !alreadyRegistered.has(candidate.timeId)) candidate.status = 'limit';
    }
    if (!valid.length) {
      session.stage = 'direct-enrollment-preview';
      this.refresh(session);
      return { ...this.renderDirectEnrollmentPreview(session, `${notice ? `${notice} ` : ''}Nenhum dos times da lista permaneceu elegível.`), editMessage: true };
    }
    session.enrollmentMode = 'direct';
    session.enrollmentTeamIds = valid;
    session.stage = 'summary';
    this.refresh(session);
    const names = new Map(snapshot.teams.map(team => [team.timeId, team.nome]));
    return { ...this.renderDirectEnrollmentConfirmation(session, snapshot.competition, notice, names), editMessage: true };
  }

  private renderDirectEnrollmentConfirmation(
    session: SelectionSession,
    competition: CompeticaoCardDto,
    notice = '',
    providedNames?: Map<number, string>,
  ): TelegramSelectionResponse {
    session.stage = 'summary';
    session.callbackNonce = randomBytes(6).toString('base64url');
    session.confirmationKey ??= randomBytes(18).toString('base64url');
    const selectedIds = session.enrollmentTeamIds ?? [];
    const names = providedNames ?? new Map(session.allTeams.map(team => [team.id, team.name]));
    const round = competition.rodadaInicio === null ? '—' : `${competition.rodadaInicio}`;
    return {
      text: `${notice ? `${notice}\n\n` : ''}🏆 Confirmar inscrição\n\nCompetição: ${this.truncate(competition.nome, 160)}\nRodada: ${round}\n\nTimes que serão inscritos: ${selectedIds.length}\n${selectedIds.map(id => `• ${this.truncate(names.get(id) ?? `Time ${id}`, 50)} (#${id})`).join('\n')}\n\nValor: GRÁTIS\n\nDeseja confirmar a inscrição?`,
      buttons: [],
      inlineKeyboard: [
        [{ text: '✅ Confirmar inscrição', callback_data: this.callbackData(session, `confirm:${session.confirmationKey}`) }],
        [{ text: '↩️ Voltar', callback_data: this.callbackData(session, 'edit-selection') }],
      ],
      sessionToken: session.sessionToken,
    };
  }

  private returnToManualSelection(session: SelectionSession): TelegramSelectionResponse {
    session.stage = 'teams';
    session.enrollmentMode = 'manual';
    session.enrollmentTeamIds = undefined;
    session.confirmationKey = undefined;
    this.refresh(session);
    return { ...this.renderTeams(session, 'Sua seleção manual foi preservada. A lista de IDs não foi combinada com ela.'), editMessage: true };
  }

  private renderBulkTeamRegistrationPrompt(session: SelectionSession, notice = ''): TelegramSelectionResponse {
    session.callbackNonce = randomBytes(6).toString('base64url');
    return {
      text: `${notice ? `${notice}\n\n` : ''}📋 Cadastro de vários times\n\nEnvie os IDs dos seus times do Cartola.\n\nVocê pode separar os IDs por linha, espaço, vírgula ou ponto e vírgula.\n\nExemplo:\n\n13933388\n25903156\n29550505\n\nMáximo: 30 IDs por envio.`,
      buttons: [],
      inlineKeyboard: [
        [{ text: '↩️ Voltar', callback_data: this.callbackData(session, 'registration-back') }],
        [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }],
        [{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }],
      ],
      sessionToken: session.sessionToken,
    };
  }

  private parseBulkTeamIds(input: string): { ids?: number[]; error?: string } {
    if (!input.trim()) return { error: 'Envie pelo menos um ID numérico.' };
    if (input.length > MAX_TEAM_ID_MESSAGE_LENGTH) {
      return { error: 'A mensagem é muito longa. Envie até 30 IDs numéricos, separados por linha, espaço, vírgula ou ponto e vírgula.' };
    }
    const tokens = input.trim().split(/[\s,;]+/u);
    if (tokens.some(token => !/^\d{1,10}$/.test(token))) {
      return { error: 'A lista contém um valor inválido. Envie somente IDs numéricos, sem nomes ou outros caracteres.' };
    }
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const token of tokens) {
      const id = Number(token);
      if (!Number.isSafeInteger(id) || id < 1 || id > 4_294_967_295) {
        return { error: 'Há um ID fora do intervalo aceito pelo POINT FFC. Confira a lista e tente novamente.' };
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (ids.length > MAX_TELEGRAM_TEAM_IDS) {
      return { error: 'Você enviou mais de 30 IDs distintos. Divida a lista em envios menores; nenhum ID foi consultado ou cadastrado.' };
    }
    return { ids };
  }

  private async previewCartolaTeams(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
    const parsed = this.parseBulkTeamIds(input);
    if (!parsed.ids) {
      this.refresh(session);
      return this.renderBulkTeamRegistrationPrompt(session, parsed.error);
    }

    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      this.refresh(session);
      return this.renderBulkTeamRegistrationPrompt(session, 'Não foi possível verificar seu vínculo agora. Tente novamente em instantes.');
    }
    if (usuarioId === null || (session.linkedUsuarioId !== undefined && usuarioId !== session.linkedUsuarioId)) {
      this.sessions.delete(session.telegramUserId);
      return this.main(`Seu vínculo POINT FFC não está ativo. Conecte sua conta para continuar:\n${LINK_URL}`);
    }

    let associations: Array<{ timeId: number; status: 'proprio' | 'outro' | 'disponivel' }>;
    try {
      associations = await this.teams.consultarStatusAssociacaoTimes(usuarioId, parsed.ids);
    } catch {
      this.refresh(session);
      return this.renderBulkTeamRegistrationPrompt(session, 'Não foi possível consultar os times cadastrados agora. Tente novamente em instantes.');
    }
    const statusById = new Map(associations.map(item => [item.timeId, item.status]));
    const lookups = await this.mapWithConcurrency(parsed.ids, CARTOLA_LOOKUP_CONCURRENCY, async (timeId): Promise<BulkTeamCandidate> => {
      const associationStatus = statusById.get(timeId);
      if (associationStatus === 'proprio') return { timeId, status: 'own' };
      if (associationStatus === 'outro') return { timeId, status: 'other' };
      try {
        const result = await this.cartola.getTeamById(timeId);
        const team = this.mapCartolaTeam(timeId, result.value);
        return { timeId, team, status: 'available' };
      } catch (error) {
        return { timeId, status: error instanceof NotFoundException ? 'not-found' : 'temporary' };
      }
    });
    session.linkedUsuarioId = usuarioId;
    session.bulkCandidates = lookups;
    session.stage = 'team-registration-bulk-preview';
    this.refresh(session);
    return this.renderBulkTeamRegistrationPreview(session);
  }

  private renderBulkTeamRegistrationPreview(session: SelectionSession): TelegramSelectionResponse {
    const candidates = session.bulkCandidates ?? [];
    const available = candidates.filter(item => item.status === 'available' && item.team);
    const own = candidates.filter(item => item.status === 'own');
    const unavailable = candidates.filter(item => item.status === 'other');
    const notFound = candidates.filter(item => item.status === 'not-found');
    const temporary = candidates.filter(item => item.status === 'temporary');
    const lines: string[] = ['📋 Prévia do cadastro', '', `✅ Times disponíveis: ${available.length}`];
    available.forEach((item, index) => lines.push(`${index + 1}. ${this.truncate(item.team?.nome ?? 'Time Cartola', 48)} — #${item.timeId}`));
    lines.push('', `ℹ️ Já cadastrados no seu perfil: ${own.length}`);
    if (own.length) lines.push(`IDs: ${this.formatTeamIds(own.map(item => item.timeId))}`);
    lines.push('', `⚠️ Indisponíveis ou associados a outro perfil: ${unavailable.length}`);
    if (unavailable.length) lines.push(`IDs: ${this.formatTeamIds(unavailable.map(item => item.timeId))}`);
    lines.push('', `❌ Não encontrados no Cartola: ${notFound.length}`);
    if (notFound.length) lines.push(`IDs: ${this.formatTeamIds(notFound.map(item => item.timeId))}`);
    lines.push('', `⏳ Consulta temporariamente indisponível: ${temporary.length}`);
    if (temporary.length) lines.push(`IDs: ${this.formatTeamIds(temporary.map(item => item.timeId))}`);
    lines.push('', available.length
      ? `Deseja adicionar os ${available.length} times disponíveis ao seu perfil POINT FFC?`
      : 'Nenhum time está disponível para cadastro. Envie outra lista para tentar novamente.');
    session.callbackNonce = randomBytes(6).toString('base64url');
    const keyboard: TelegramInlineButton[][] = [];
    if (available.length) keyboard.push([{ text: '✅ Confirmar cadastro', callback_data: this.callbackData(session, 'registration-bulk-confirm') }]);
    keyboard.push([{ text: '✏️ Enviar outra lista', callback_data: this.callbackData(session, 'registration-bulk-edit') }]);
    keyboard.push([{ text: CANCEL_BUTTON, callback_data: this.callbackData(session, 'cancel') }]);
    keyboard.push([{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }]);
    return { text: lines.join('\n'), buttons: [], inlineKeyboard: keyboard, sessionToken: session.sessionToken };
  }

  private async confirmBulkTeamRegistration(session: SelectionSession): Promise<TelegramSelectionResponse> {
    const original = session.bulkCandidates;
    if (!original?.length) return this.bulkRegistrationFailure(session, 'A prévia não está mais disponível. Envie a lista novamente.');

    // Rotate the nonce and stage before awaiting any external work. A repeated callback
    // cannot start a second batch even if Telegram delivers it while this one is running.
    session.stage = 'team-registration-bulk-processing';
    session.callbackNonce = randomBytes(6).toString('base64url');
    this.refresh(session);

    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return this.bulkRegistrationFailure(session, 'Não foi possível validar seu vínculo. Nenhum novo cadastro foi iniciado; consulte os times e tente novamente.');
    }
    if (usuarioId === null || usuarioId !== session.linkedUsuarioId) {
      this.sessions.delete(session.telegramUserId);
      return { text: `Seu vínculo POINT FFC não está ativo. Conecte sua conta para continuar:\n${LINK_URL}`, buttons: [],
        inlineKeyboard: [], sessionToken: session.sessionToken, editMessage: true, showMainMenu: true };
    }

    const teamCandidates = original.filter(item => item.status === 'available' && item.team);
    let currentAssociations: Array<{ timeId: number; status: 'proprio' | 'outro' | 'disponivel' }>;
    try {
      currentAssociations = await this.teams.consultarStatusAssociacaoTimes(usuarioId, original.map(item => item.timeId));
    } catch {
      return this.bulkRegistrationFailure(session, 'Não foi possível revalidar as associações. Nenhum cadastro foi iniciado; envie a lista novamente mais tarde.');
    }
    const currentStatusById = new Map(currentAssociations.map(item => [item.timeId, item.status]));
    const refreshed = await this.mapWithConcurrency(teamCandidates.filter(item => item.status === 'available'), CARTOLA_LOOKUP_CONCURRENCY,
      async (candidate): Promise<BulkTeamCandidate> => {
        try {
          const result = await this.cartola.getTeamById(candidate.timeId, { forceRefresh: true });
          const team = this.mapCartolaTeam(candidate.timeId, result.value);
          const status = currentStatusById.get(candidate.timeId);
          if (status === 'proprio') return { timeId: candidate.timeId, status: 'own', team };
          if (status === 'outro') return { timeId: candidate.timeId, status: 'other', team };
          return { timeId: candidate.timeId, status: 'available', team };
        } catch (error) {
          return { timeId: candidate.timeId, status: error instanceof NotFoundException ? 'not-found' : 'temporary' };
        }
      });

    const result: BulkRegistrationSummary = {
      total: original.length, added: [], alreadyOwn: [], unavailable: [], notFound: [], pending: [],
    };
    for (const candidate of original) {
      const currentStatus = currentStatusById.get(candidate.timeId);
      if (currentStatus === 'proprio') result.alreadyOwn.push(candidate.timeId);
      else if (currentStatus === 'outro') result.unavailable.push(candidate.timeId);
      else if (candidate.status === 'own' || candidate.status === 'other') result.pending.push(candidate.timeId);
      else if (candidate.status === 'not-found') result.notFound.push(candidate.timeId);
      else if (candidate.status === 'temporary') result.pending.push(candidate.timeId);
    }
    const currentById = new Map(refreshed.map(item => [item.timeId, item]));
    const toRegister: AdicionarTimeDto[] = [];
    for (const candidate of teamCandidates.filter(item => item.status === 'available')) {
      const current = currentById.get(candidate.timeId);
      if (current?.status === 'own') result.alreadyOwn.push(candidate.timeId);
      else if (current?.status === 'other') result.unavailable.push(candidate.timeId);
      else if (current?.status === 'not-found') result.notFound.push(candidate.timeId);
      else if (current?.status === 'temporary') result.pending.push(candidate.timeId);
      else if (current?.status === 'available' && current.team) toRegister.push(this.teamRegistrationDto(current.team));
      else result.pending.push(candidate.timeId);
    }

    let batch: Awaited<ReturnType<MeusTimesService['adicionarTimesEmLote']>> | undefined;
    if (toRegister.length) {
      try {
        batch = await this.teams.adicionarTimesEmLote(usuarioId, toRegister);
      } catch {
        // Do not retry a possibly committed write. Resolve the final owner state below.
      }
    }
    const attemptedIds = toRegister.map(item => item.timeId);
    if (attemptedIds.length) {
      try {
        const finalAssociations = await this.teams.consultarStatusAssociacaoTimes(usuarioId, attemptedIds);
        const finalStatusById = new Map(finalAssociations.map(item => [item.timeId, item.status]));
        const addedByService = new Set(batch?.timesAdicionados ?? []);
        for (const timeId of attemptedIds) {
          const status = finalStatusById.get(timeId);
          if (status === 'proprio') {
            if (addedByService.has(timeId)) result.added.push(timeId);
            else result.alreadyOwn.push(timeId);
          } else if (status === 'outro') result.unavailable.push(timeId);
          else result.pending.push(timeId);
        }
      } catch {
        // Successful service results are committed; unresolved outcomes are reported as pending.
        const addedByService = new Set(batch?.timesAdicionados ?? []);
        for (const timeId of attemptedIds) {
          if (addedByService.has(timeId)) result.added.push(timeId);
          else result.pending.push(timeId);
        }
      }
      const failedIds = new Set(batch?.falhas.map(item => item.timeId).filter((id): id is number => id !== null) ?? []);
      for (const timeId of attemptedIds) {
        if (failedIds.has(timeId) && !result.added.includes(timeId) && !result.alreadyOwn.includes(timeId)
          && !result.unavailable.includes(timeId) && !result.pending.includes(timeId)) result.pending.push(timeId);
      }
    }

    session.bulkResult = this.uniqueBulkResult(result);
    session.bulkCandidates = original.map(candidate => ({ ...candidate }));
    session.stage = 'team-registration-bulk-result';
    this.refresh(session);
    return { ...this.renderBulkTeamRegistrationResult(session), editMessage: true };
  }

  private bulkRegistrationFailure(session: SelectionSession, message: string): TelegramSelectionResponse {
    const candidates = session.bulkCandidates ?? [];
    const result: BulkRegistrationSummary = {
      total: candidates.length,
      added: [],
      alreadyOwn: candidates.filter(item => item.status === 'own').map(item => item.timeId),
      unavailable: candidates.filter(item => item.status === 'other').map(item => item.timeId),
      notFound: candidates.filter(item => item.status === 'not-found').map(item => item.timeId),
      pending: candidates.filter(item => item.status === 'available' || item.status === 'temporary').map(item => item.timeId),
    };
    session.bulkResult = result;
    session.stage = 'team-registration-bulk-result';
    this.refresh(session);
    return { ...this.renderBulkTeamRegistrationResult(session, message), editMessage: true };
  }

  private renderBulkTeamRegistrationResult(session: SelectionSession, notice = ''): TelegramSelectionResponse {
    const result = session.bulkResult ?? { total: 0, added: [], alreadyOwn: [], unavailable: [], notFound: [], pending: [] };
    const lines = [
      `${notice ? `${notice}\n\n` : result.added.length ? '✅ Cadastro concluído!\n\n' : ''}📋 Resultado do lote`,
      '',
      ...(!notice && result.added.length === 0 ? ['Nenhum novo time foi cadastrado.', ''] : []),
      `✅ Adicionados: ${result.added.length}`,
      `ℹ️ Já cadastrados no seu perfil: ${result.alreadyOwn.length}`,
      `⚠️ Indisponíveis ou associados a outro perfil: ${result.unavailable.length}`,
      `❌ Não encontrados: ${result.notFound.length}`,
      `⏳ Pendentes por falha temporária ou resultado incerto: ${result.pending.length}`,
      '',
      `Total de IDs distintos: ${result.total}`,
    ];
    if (result.pending.length) lines.push('', `IDs pendentes: ${this.formatTeamIds(result.pending)}`,
      'Confira seus times cadastrados no POINT FFC antes de reenviar esses IDs.');
    if (result.unavailable.length) lines.push('', `IDs indisponíveis: ${this.formatTeamIds(result.unavailable)}`);
    session.callbackNonce = randomBytes(6).toString('base64url');
    const keyboard: TelegramInlineButton[][] = [
      ...(session.registrationOrigin === 'account'
        ? [[{ text: '⚽ Participar', callback_data: this.callbackData(session, 'registration-participate') }],
          [{ text: '🔗 Minha conta', callback_data: this.callbackData(session, 'registration-account') }]]
        : [[{ text: '⚽ Voltar à competição', callback_data: this.callbackData(session, 'registration-return') }]]),
      [{ text: '📋 Cadastrar mais times', callback_data: this.callbackData(session, 'registration-bulk-add-another') }],
      [{ text: HOME_BUTTON, callback_data: this.callbackData(session, 'main-menu') }],
    ];
    return { text: lines.join('\n'), buttons: [], inlineKeyboard: keyboard, sessionToken: session.sessionToken };
  }

  private formatTeamIds(ids: number[]): string {
    return ids.map(timeId => `#${timeId}`).join(', ');
  }

  private teamRegistrationDto(team: CartolaTeamRegistration): AdicionarTimeDto {
    return {
      timeId: team.timeId, nome: team.nome,
      ...(team.nomeCartola ? { nomeCartola: team.nomeCartola } : {}),
      ...(team.slug ? { slug: team.slug } : {}),
      ...(team.urlEscudoPng ? { urlEscudoPng: team.urlEscudoPng } : {}),
      ...(team.fotoPerfil ? { fotoPerfil: team.fotoPerfil } : {}),
      ...(team.assinante !== undefined ? { assinante: team.assinante } : {}),
    };
  }

  private uniqueBulkResult(result: BulkRegistrationSummary): BulkRegistrationSummary {
    const dedupe = (ids: number[]) => [...new Set(ids)];
    return {
      total: result.total, added: dedupe(result.added), alreadyOwn: dedupe(result.alreadyOwn),
      unavailable: dedupe(result.unavailable), notFound: dedupe(result.notFound), pending: dedupe(result.pending),
    };
  }

  private async mapWithConcurrency<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(items.length, limit);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await map(items[index]);
      }
    }));
    return results;
  }

  private async returnToCompetitionOrList(session: SelectionSession): Promise<TelegramSelectionResponse> {
    let usuarioId: number | null;
    try { usuarioId = await this.resolveUser(session.telegramUserId); } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível validar sua conta POINT FFC. Tente novamente.' };
    }
    if (usuarioId === null || (session.linkedUsuarioId !== undefined && usuarioId !== session.linkedUsuarioId)) {
      return this.endJourney(session, 'Seu vínculo POINT FFC não está ativo. Conecte sua conta para continuar.');
    }
    if (session.competitionId) {
      try {
        const current = await this.competitions.buscarGratuitaElegivel(session.competitionId);
        if (current?.tipoAcesso === 'FREE') {
          const index = session.competitions.findIndex(item => item.id === current.id);
          if (index >= 0) session.competitions[index] = current;
          else session.competitions.push(current);
          const response = await this.showTeams(session, current.id, usuarioId);
          return { ...response, editMessage: true };
        }
      } catch {
        // Fall back to the current eligible competition list below.
      }
    }
    try {
      session.competitions = await this.competitions.listarGratuitasElegiveis();
      session.competitionId = undefined;
      session.stage = 'competitions';
      session.page = 0;
      session.competitionOptions = [];
      session.allTeams = [];
      session.selectedTeamIds = [];
      session.candidateTeam = undefined;
      if (session.competitions.length === 0) {
        session.stage = session.bulkResult ? 'team-registration-bulk-result' : 'team-registration-result';
        this.refresh(session);
        const notice = 'A competição deixou de estar disponível. Não há competições gratuitas abertas no momento.';
        return {
          ...(session.bulkResult
            ? this.renderBulkTeamRegistrationResult(session, notice)
            : this.renderTeamRegistrationResult(session, notice)),
          editMessage: true,
        };
      }
      this.refresh(session);
      return { ...this.renderCompetitionPage(session, 'A competição anterior não está mais aberta. Escolha outra competição gratuita.'), editMessage: true };
    } catch {
      return { text: '', buttons: [], answerText: 'Não foi possível consultar as competições agora. Seu time foi cadastrado e pode ser consultado em Minha conta.' };
    }
  }

  private async showTeams(session: SelectionSession, competitionId: number, usuarioId: number): Promise<TelegramSelectionResponse> {
    session.stage = 'teams';
    session.competitionId = competitionId;
    session.linkedUsuarioId = usuarioId;
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
    if (!session.competitionId) return { competition: null, registrations: [], teams: [], ownedTeamCount: 0, activeParticipants: 0 };
    const competition = await this.competitions.buscarGratuitaElegivel(session.competitionId);
    if (!competition) return { competition: null, registrations: [], teams: [], ownedTeamCount: 0, activeParticipants: 0 };
    const [registrations, ownedTeams, activeParticipants] = await Promise.all([
      this.inscriptions.minhas(competition.id, usuarioId),
      this.teams.listarTimesDoUsuario(usuarioId),
      this.competitions.contarParticipantesAtivos(competition.id),
    ]);
    return { competition, registrations, teams: ownedTeams, ownedTeamCount: ownedTeams.length, activeParticipants };
  }

  private applyEligibility(session: SelectionSession, snapshot: EligibilitySnapshot): number {
    if (!snapshot.competition) return session.selectedTeamIds.length;
    session.ownedTeamCount = snapshot.ownedTeamCount;
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
    if (session.allTeams.length === 0 && (session.ownedTeamCount ?? 0) === 0) {
      return {
        text: `⚽ Selecione os times para participar\n\nVocê ainda não possui times cadastrados no POINT FFC. Informe uma lista de IDs do Cartola para inscrever seus times nesta competição.${prefix ? `\n\n${prefix}` : ''}`,
        buttons: [],
        inlineKeyboard: [
          [{ text: '📋 Inscrever por lista de IDs', callback_data: this.callbackData(session, 'direct-enrollment') }],
          [{ text: BACK_BUTTON, callback_data: this.callbackData(session, 'back-competitions') }],
        ],
        sessionToken: session.sessionToken,
      };
    }
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
    keyboard.push([{ text: '📋 Inscrever por lista de IDs', callback_data: this.callbackData(session, 'direct-enrollment') }]);
    if (session.selectedTeamIds.length > 0) {
      keyboard.push([{
        text: `➡️ Continuar com selecionados (${session.selectedTeamIds.length})`,
        callback_data: this.callbackData(session, 'continue'),
      }]);
    }
    keyboard.push([{ text: BACK_BUTTON, callback_data: this.callbackData(session, 'back-competitions') }]);

    const competition = session.competitions.find(item => item.id === session.competitionId);
    const countText = `Times selecionados: ${session.selectedTeamIds.length}`;
    const limitText = session.maxSelectableTeams < session.allTeams.length
      ? `\nLimite disponível: ${session.maxSelectableTeams}` : '';
    const pageText = session.allTeams.length > PAGE_SIZE
      ? `\nPágina ${session.page + 1} de ${Math.ceil(session.allTeams.length / PAGE_SIZE)}` : '';
    const emptyText = session.allTeams.length === 0 || session.maxSelectableTeams === 0
      ? '\nNão há times elegíveis disponíveis nesta competição.' : '';
    return {
      text: `${prefix ? `${prefix}\n\n` : ''}${competition ? `${this.formatCompetition(competition)}\n\n` : ''}⚽ Selecione os times para participar\n\nEscolha seus times cadastrados ou informe uma lista de IDs do Cartola para inscrição direta.\n${countText}${limitText}${pageText}${emptyText}`,
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
    if (['previous', 'next', 'toggle-all', 'clear', 'continue', 'edit-selection', 'cancel', 'back-competitions', 'back-to-competitions', 'participate-selected', 'main-menu', 'my-inscriptions',
      'add-team', 'add-bulk-teams', 'account-register-one', 'account-register-bulk', 'registration-back', 'registration-confirm', 'registration-participate', 'registration-add-another', 'registration-account',
      'registration-return', 'registration-bulk-confirm', 'registration-bulk-edit', 'registration-bulk-add-another', 'direct-enrollment', 'direct-back-manual',
      'direct-edit', 'direct-continue', 'direct-register-confirm', 'account-wallet', 'wallet-add', 'wallet-refresh', 'wallet-back',
      'wallet-confirm', 'wallet-edit', 'wallet-abandon', 'wallet-recover'].includes(action)) return action;
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

  private main(text: string, buttons = [['🏆 Competições', '📋 Minhas inscrições'], ['🔗 Minha conta']]): TelegramSelectionResponse {
    return { text, buttons };
  }

  private truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isSelectionInput(text: string): boolean {
    return text === CANCEL_BUTTON || text === PREVIOUS_BUTTON || text === MORE_BUTTON
      || /^\d{1,10}$/.test(text)
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
