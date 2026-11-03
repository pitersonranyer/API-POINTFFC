export interface Participante { idExterno: number | null; nome: string | null }
export interface Equipe extends Participante { logo: string | null }
export interface Posicao { nome: string | null; codigo: string | null; categoria: string | null }
export interface JogadorFormacao extends Participante {
  numero: number | null; foto: string | null; posicao: string | null;
  posicaoCadastral: Posicao | null; funcaoPartida: Posicao;
  grid: string | null; coordenada: { linha: number | null; coluna: number | null } | null;
}
export interface Escalacao {
  formacao: string | null; treinador: (Participante & { foto: string | null }) | null;
  titulares: JogadorFormacao[]; reservas: JogadorFormacao[]; atualizadoEm: string | null;
}
export interface EventoSumario {
  tipo: 'GOL' | 'CARTAO_AMARELO' | 'CARTAO_VERMELHO' | 'SUBSTITUICAO' | 'VAR'; periodo: string | null;
  tempo: { minuto: number | null; acrescimo: number | null; exibicao: string | null };
  equipe: Equipe; jogador: Participante | null; assistencia: Participante | null;
  jogadorSai: Participante | null; jogadorEntra: Participante | null;
  comissaoTecnica: Participante | null; comentarios: string | null;
  origem: { tipo: string; detalhe: string | null };
}
export interface EstatisticasEquipe {
  finalizacoesNoGol: number | null; finalizacoesFora: number | null; finalizacoes: number | null;
  finalizacoesBloqueadas: number | null; finalizacoesDentroArea: number | null; finalizacoesForaArea: number | null;
  faltas: number | null; escanteios: number | null; impedimentos: number | null; posseBola: number | null;
  cartoesAmarelos: number | null; cartoesVermelhos: number | null; defesasGoleiro: number | null;
  passes: number | null; passesCertos: number | null; precisaoPasses: number | null;
  golsEsperados: number | null; golsEvitados: number | null;
}

// Tipos públicos inferidos dos contratos normalizados, sem expor o envelope da fornecedora.
export type PreJogoPartida = ReturnType<typeof import('./api-futebol-v2.mapper').mapPreJogo>;
export type SumarioPartida = ReturnType<typeof import('./api-futebol-v2.mapper').mapSumario>;
export type FormacaoPartida = ReturnType<typeof import('./api-futebol-v2.mapper').mapFormacao>;
export type EstatisticasPartida = ReturnType<typeof import('./api-futebol-v2.mapper').mapEstatisticas>;
