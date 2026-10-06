export interface Participante { idExterno: number | null; nome: string | null }
export interface Equipe extends Participante { logo: string | null }
export interface Placar { mandante: number | null; visitante: number | null }
export interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string }; venue: { name: string | null } };
  league: { name: string; round: string | null };
  teams: { home: { id: number; name: string; logo: string | null }; away: { id: number; name: string; logo: string | null } };
  goals: { home: number | null; away: number | null };
}
export interface ApiEvent {
  time: { elapsed: number | null; extra: number | null };
  team: { id: number | null; name: string | null; logo?: string | null };
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
  type: string; detail: string; comments: string | null;
}
export interface EventoSumario {
  tipo: 'GOL' | 'CARTAO_AMARELO' | 'SUBSTITUICAO' | 'VAR_GOL_ANULADO' | 'DESCONHECIDO';
  tempo: { minuto: number | null; acrescimo: number | null; exibicao: string | null };
  equipe: Equipe;
  jogador?: Participante | null;
  assistencia?: Participante | null;
  jogadorSai?: Participante | null;
  jogadorEntra?: Participante | null;
  comentarios: string | null;
  origem: { tipo: string; detalhe: string };
  placarAposEvento?: Placar;
}
export interface SumarioPartida {
  partida: { idExterno: number; campeonato: string; rodada: number | null; fase: string | null;
    status: string; data: string; estadio: string | null; mandante: Equipe; visitante: Equipe; placar: Placar };
  eventos: EventoSumario[];
}

export interface ApiTeamStatistics {
  team: ApiFixture['teams']['home'];
  statistics: { type: string; value: number | string | null }[];
}
export interface EstatisticasEquipe {
  finalizacoesNoGol: number | null;
  finalizacoesFora: number | null;
  finalizacoes: number | null;
  finalizacoesBloqueadas: number | null;
  finalizacoesDentroArea: number | null;
  finalizacoesForaArea: number | null;
  faltas: number | null;
  escanteios: number | null;
  impedimentos: number | null;
  posseBola: number | null;
  cartoesAmarelos: number | null;
  cartoesVermelhos: number | null;
  defesasGoleiro: number | null;
  passes: number | null;
  passesCertos: number | null;
  precisaoPasses: number | null;
  golsEsperados: number | null;
  golsEvitados: number | null;
}
export interface EstatisticasPartida {
  partida: { idExterno: number };
  mandante: Equipe & { estatisticas: EstatisticasEquipe };
  visitante: Equipe & { estatisticas: EstatisticasEquipe };
}
