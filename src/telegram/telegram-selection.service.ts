import { Injectable } from '@nestjs/common';
import { CompeticaoCardDto } from '../ligas-competicoes/dto/ligas-competicoes-response.dto';
import { MinhaInscricaoDto } from '../ligas-competicoes/dto/inscricoes-competicao.dto';
import { InscricoesCompeticaoService } from '../ligas-competicoes/inscricoes-competicao.service';
import { TimeUsuarioResponseDto } from '../meus-times/dto/time-usuario-response.dto';
import { MeusTimesService } from '../meus-times/meus-times.service';
import { TelegramLinkService } from '../telegram-link/telegram-link.service';
import { TelegramCompetitionsService } from './telegram-competitions.service';

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 1000;
const PAGE_SIZE = 8;
const CANCEL_BUTTON = '❌ Cancelar';
const MORE_BUTTON = '➡️ Mais opções';
const BACK_TO_COMPETITIONS_BUTTON = '🏆 Voltar às competições';
const BACK_TO_TIMES_BUTTON = '🔄 Escolher outro time';
const LINK_URL = 'https://pointffc.com.br/conectar-telegram/';

type SelectionStage = 'competitions' | 'teams' | 'summary';
interface Option<T> { button: string; value: T }

interface SelectionSession {
  telegramUserId: string;
  stage: SelectionStage;
  expiresAt: number;
  competitions: CompeticaoCardDto[];
  competitionId?: number;
  teamId?: number;
  page: number;
  competitionOptions: Option<number>[];
  teamOptions: Option<number>[];
  allTeams: Array<{ id: number; name: string }>;
}

export interface TelegramSelectionResponse {
  text: string;
  buttons: string[][];
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
      teamOptions: [],
      allTeams: [],
    };
    this.saveSession(session);
    return this.competitionsPage(session);
  }

  clear(telegramUserId: string): void {
    this.sessions.delete(telegramUserId);
  }

  async handle(telegramUserId: string, text: string): Promise<TelegramSelectionResponse | null> {
    const previous = this.userQueues.get(telegramUserId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.userQueues.set(telegramUserId, current);
    await previous.catch(() => undefined);
    try {
      return await this.handleSequentially(telegramUserId, text);
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
    if (session.stage === 'teams') return this.handleTeamStep(session, input);
    return this.handleSummaryStep(session, input);
  }

  private async handleCompetitionStep(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
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

    let competition: CompeticaoCardDto | null;
    try {
      competition = await this.competitions.buscarGratuitaElegivel(option.value);
    } catch {
      return this.main('Não foi possível revalidar essa competição agora. Inicie novamente em alguns instantes.');
    }
    if (!competition) {
      this.sessions.delete(session.telegramUserId);
      return this.start(session.telegramUserId).then(result => ({
        ...result,
        text: `Essa competição não está mais disponível para participação.\n\n${result.text}`,
      }));
    }

    try {
      const registrations = await this.inscriptions.minhas(competition.id, usuarioId);
      const activeCount = registrations.filter(registration => registration.statusInscricao === 'ATIVA').length;
      const limit = competition.limiteTimesUsuario;
      if (limit !== null && activeCount >= limit) {
        session.stage = 'teams';
        session.competitionId = competition.id;
        session.competitions[session.competitions.findIndex(item => item.id === competition.id)] = competition;
        session.teamOptions = [];
        this.refresh(session);
        return {
          text: `O limite de ${limit} time(s) por usuário nesta competição já foi atingido.\n\n${this.formatCompetition(competition)}`,
          buttons: [[BACK_TO_COMPETITIONS_BUTTON], [CANCEL_BUTTON]],
        };
      }
      return await this.showTeams(session, competition, usuarioId, registrations);
    } catch {
      return this.main('Não foi possível consultar seus times agora. Tente iniciar a jornada novamente em instantes.');
    }
  }

  private async handleTeamStep(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
    if (input === BACK_TO_COMPETITIONS_BUTTON) return this.start(session.telegramUserId);
    if (input === MORE_BUTTON && (session.page + 1) * PAGE_SIZE < session.allTeams.length) {
      session.page += 1;
      this.refresh(session);
      return this.teamsPage(session);
    }
    const option = session.teamOptions.find(item => item.button === input);
    if (!option) return this.teamsPage(session, 'Escolha um dos seus times pelos botões abaixo.');

    let usuarioId: number | null;
    try {
      usuarioId = await this.resolveUser(session.telegramUserId);
    } catch {
      return this.main('Não foi possível verificar seu vínculo agora. Tente novamente em instantes.');
    }
    if (usuarioId === null) {
      this.sessions.delete(session.telegramUserId);
      return this.main(`Não foi possível confirmar seu vínculo ativo. Conecte sua conta POINT FFC e inicie novamente:\n${LINK_URL}`);
    }
    let competition: CompeticaoCardDto | null;
    try {
      competition = await this.getCurrentCompetition(session);
    } catch {
      return this.main('Não foi possível revalidar essa competição agora. Tente novamente em instantes.');
    }
    if (!competition) {
      this.sessions.delete(session.telegramUserId);
      return this.main('A competição não está mais disponível. Toque em “⚽ Participar grátis” para consultar novamente.');
    }

    try {
      const [registrations, teams] = await Promise.all([
        this.inscriptions.minhas(competition.id, usuarioId),
        this.teams.listarTimesDoUsuario(usuarioId),
      ]);
      const registeredIds = new Set(registrations.map(registration => registration.timeIdCartola));
      const selectedTeam = teams.find(team => team.timeId === option.value);
      if (!selectedTeam || registeredIds.has(option.value)) {
        return await this.showTeams(session, competition, usuarioId, registrations, 'Esse time não está mais disponível para esta competição.');
      }
      const activeCount = registrations.filter(registration => registration.statusInscricao === 'ATIVA').length;
      if (competition.limiteTimesUsuario !== null && activeCount >= competition.limiteTimesUsuario) {
        return {
          text: `O limite de ${competition.limiteTimesUsuario} time(s) por usuário nesta competição já foi atingido.`,
          buttons: [[BACK_TO_COMPETITIONS_BUTTON], [CANCEL_BUTTON]],
        };
      }
      session.stage = 'summary';
      session.competitionId = competition.id;
      session.teamId = selectedTeam.timeId;
      session.teamOptions = [];
      this.refresh(session);
      return this.summary(session, competition, selectedTeam);
    } catch {
      return this.main('Não foi possível validar a seleção agora. Inicie novamente em alguns instantes.');
    }
  }

  private async handleSummaryStep(session: SelectionSession, input: string): Promise<TelegramSelectionResponse> {
    if (input === BACK_TO_COMPETITIONS_BUTTON) return this.start(session.telegramUserId);
    if (input === BACK_TO_TIMES_BUTTON) {
      let usuarioId: number | null;
      try {
        usuarioId = await this.resolveUser(session.telegramUserId);
      } catch {
        return this.main('Não foi possível verificar seu vínculo agora. Tente novamente em instantes.');
      }
      if (usuarioId === null) {
        this.sessions.delete(session.telegramUserId);
        return this.main(`Não foi possível confirmar seu vínculo ativo. Conecte sua conta POINT FFC e inicie novamente:\n${LINK_URL}`);
      }
      let competition: CompeticaoCardDto | null;
      try {
        competition = await this.getCurrentCompetition(session);
      } catch {
        return this.main('Não foi possível revalidar essa competição agora. Tente novamente em instantes.');
      }
      if (!competition) {
        this.sessions.delete(session.telegramUserId);
        return this.main('A competição não está mais disponível. Toque em “⚽ Participar grátis” para consultar novamente.');
      }
      try {
        const registrations = await this.inscriptions.minhas(competition.id, usuarioId);
        return this.showTeams(session, competition, usuarioId, registrations);
      } catch {
        return this.main('Não foi possível consultar seus times agora. Tente novamente mais tarde.');
      }
    }
    return this.main('Seu time foi selecionado. A inscrição ainda não foi realizada.', [
      [BACK_TO_TIMES_BUTTON], [BACK_TO_COMPETITIONS_BUTTON], [CANCEL_BUTTON],
    ]);
  }

  private async showTeams(
    session: SelectionSession,
    competition: CompeticaoCardDto,
    usuarioId: number,
    registrations: MinhaInscricaoDto[],
    prefix = '',
  ): Promise<TelegramSelectionResponse> {
    const teams = await this.teams.listarTimesDoUsuario(usuarioId);
    const registeredIds = new Set(registrations.map(registration => registration.timeIdCartola));
    const available = teams.filter(team => !registeredIds.has(team.timeId));
    session.stage = 'teams';
    session.competitionId = competition.id;
    session.competitions[session.competitions.findIndex(item => item.id === competition.id)] = competition;
    session.allTeams = available.map(team => ({ id: team.timeId, name: team.nome }));
    session.teamOptions = [];
    session.page = 0;
    this.refresh(session);
    if (available.length === 0) {
      return {
        text: `${prefix ? `${prefix}\n\n` : ''}Não há times disponíveis para seleção nesta competição.\n\n${this.formatCompetition(competition)}`,
        buttons: [[BACK_TO_COMPETITIONS_BUTTON], [CANCEL_BUTTON]],
      };
    }
    return this.teamsPage(session, prefix);
  }

  private competitionsPage(session: SelectionSession, prefix = ''): TelegramSelectionResponse {
    const start = session.page * PAGE_SIZE;
    const pageItems = session.competitions.slice(start, start + PAGE_SIZE);
    session.competitionOptions = pageItems.map((competition, index) => ({
      button: `${start + index + 1}. ${this.truncate(competition.nome, 38)} (R${competition.rodadaInicio ?? '—'}, #${competition.id})`,
      value: competition.id,
    }));
    const lines = pageItems.map((competition, index) => `${index + 1}. ${this.formatCompetition(competition)}`);
    const buttons = this.rows(session.competitionOptions.map(option => option.button));
    if (start + PAGE_SIZE < session.competitions.length) buttons.push([MORE_BUTTON]);
    buttons.push([CANCEL_BUTTON]);
    return {
      text: `${prefix ? `${prefix}\n\n` : ''}⚽ Competições gratuitas abertas — escolha uma opção:\n\n${lines.join('\n\n')}`,
      buttons,
    };
  }

  private teamsPage(session: SelectionSession, prefix = ''): TelegramSelectionResponse {
    const start = session.page * PAGE_SIZE;
    const teamOptions = session.allTeams.slice(start, start + PAGE_SIZE).map((team, index) => {
      const ordinal = start + index + 1;
      return { button: `${ordinal}. ${this.truncate(team.name, 32)} (#${team.id})`, value: team.id };
    });
    session.teamOptions = teamOptions;
    const competition = session.competitions.find(item => item.id === session.competitionId);
    const buttons = this.rows(teamOptions.map(option => option.button));
    if (start + PAGE_SIZE < session.allTeams.length) buttons.push([MORE_BUTTON]);
    buttons.push([BACK_TO_COMPETITIONS_BUTTON], [CANCEL_BUTTON]);
    return {
      text: `${prefix ? `${prefix}\n\n` : ''}${competition ? `${this.formatCompetition(competition)}\n\n` : ''}Escolha um dos seus times:\n${teamOptions.map(option => option.button).join('\n')}`,
      buttons,
    };
  }

  private summary(session: SelectionSession, competition: CompeticaoCardDto, team: TimeUsuarioResponseDto): TelegramSelectionResponse {
    return {
      text: `Resumo da seleção\n\nCompetição: ${this.truncate(competition.nome, 180)}\nRodada: ${competition.rodadaInicio ?? '—'}${competition.rodadaFim && competition.rodadaFim !== competition.rodadaInicio ? `–${competition.rodadaFim}` : ''}\nTime: ${this.truncate(team.nome, 140)} (#${team.timeId})\nValor: R$ 0,00\n\nSeu time foi selecionado. A inscrição ainda não foi realizada.`,
      buttons: [[BACK_TO_TIMES_BUTTON], [BACK_TO_COMPETITIONS_BUTTON], [CANCEL_BUTTON]],
    };
  }

  private async getCurrentCompetition(session: SelectionSession): Promise<CompeticaoCardDto | null> {
    if (!session.competitionId) return null;
    return this.competitions.buscarGratuitaElegivel(session.competitionId);
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
    return text === CANCEL_BUTTON || text === MORE_BUTTON
      || text === BACK_TO_COMPETITIONS_BUTTON || text === BACK_TO_TIMES_BUTTON
      || /^\d+\. .+\(R[^,]+, #\d+\)$/.test(text)
      || /^\d+\. .+\(#\d+\)$/.test(text);
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
