import { BadGatewayException } from '@nestjs/common';
import { Registro, registro } from './api-futebol-v2.client';
import { Equipe, Escalacao, EstatisticasEquipe, EventoSumario, JogadorFormacao, Participante } from './fantasy.types';

function texto(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new BadGatewayException('Texto inválido do serviço de partidas');
  return v;
}
function numero(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadGatewayException('Número inválido do serviço de partidas');
  return v;
}
function booleano(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v !== 'boolean') throw new BadGatewayException('Indicador inválido do serviço de partidas');
  return v;
}
function objeto(v: unknown): Registro { return v == null ? {} : registro(v); }
function lista(v: unknown): Registro[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new BadGatewayException('Lista inválida do serviço de partidas');
  return v.map(registro);
}
function participante(v: unknown): Participante | null {
  if (v == null) return null;
  const p = registro(v);
  return { idExterno: numero(p.id), nome: texto(p.nome) };
}
function equipe(v: unknown): Equipe {
  const p = registro(v);
  if (!Number.isSafeInteger(p.id) || Number(p.id) <= 0 || typeof p.nome !== 'string') throw new BadGatewayException('Equipe inválida do serviço de partidas');
  return { idExterno: p.id as number, nome: p.nome, logo: texto(p.escudo) };
}
function posicao(p: Registro) { return { nome: texto(p.posicao), codigo: texto(p.posicao_codigo), categoria: texto(p.posicao_categoria) }; }
function jogador(p: Registro): JogadorFormacao {
  if (!Number.isSafeInteger(p.id) || Number(p.id) <= 0) throw new BadGatewayException('Atleta inválido do serviço de partidas');
  return { ...participante(p)!, numero: numero(p.numero_camisa), foto: texto(p.foto), posicao: texto(p.posicao),
    posicaoCadastral: null, funcaoPartida: posicao(p), grid: texto(p.grid),
    coordenada: p.coordenada == null ? null : { linha: numero(registro(p.coordenada).linha), coluna: numero(registro(p.coordenada).coluna) } };
}
function escalacao(v: unknown): Escalacao | null {
  if (v == null) return null;
  const p = registro(v);
  const titulares = lista(p.titulares).map(jogador), reservas = lista(p.reservas).map(jogador);
  const ids = [...titulares, ...reservas].map(a => a.idExterno);
  if (new Set(ids).size !== ids.length) throw new BadGatewayException('Atleta duplicado na escalação');
  return { formacao: texto(p.formacao), treinador: p.tecnico == null ? null : { ...participante(p.tecnico)!, foto: texto(registro(p.tecnico).foto) },
    titulares, reservas, atualizadoEm: texto(p.atualizado_em) };
}
export function partida(d: Registro) {
  const estados: Record<string, string> = { finalizado: 'ENCERRADA', andamento: 'EM_ANDAMENTO', agendado: 'AGENDADA', 'pre-jogo': 'PRE_JOGO', adiado: 'ADIADA', suspenso: 'INTERROMPIDA', cancelado: 'CANCELADA', abandonado: 'ABANDONADA', wo: 'RESULTADO_ADMINISTRATIVO' };
  const campeonato = objeto(d.campeonato), fase = objeto(d.fase), placar = objeto(d.placar);
  const mandante = equipe(d.mandante), visitante = equipe(d.visitante);
  if (mandante.idExterno === visitante.idExterno) throw new BadGatewayException('Equipes divergentes do serviço de partidas');
  return { idExterno: numero(d.id), fornecedor: 'API_FUTEBOL_V2' as const, campeonato: texto(campeonato.nome),
    campeonatoId: numero(campeonato.id), temporada: texto(objeto(d.temporada).nome), rodada: numero(d.rodada), fase: texto(fase.nome),
    status: d.periodo === 'intervalo' ? 'INTERVALO' : estados[String(d.status)] ?? 'DESCONHECIDO', statusOriginal: texto(d.status), periodo: texto(d.periodo),
    minuto: numero(d.minuto), acrescimos: {
      primeiroTempo: numero(objeto(d.acrescimos).primeiro_tempo), segundoTempo: numero(objeto(d.acrescimos).segundo_tempo),
      primeiroTempoProrrogacao: numero(objeto(d.acrescimos).primeiro_tempo_prorrogacao), segundoTempoProrrogacao: numero(objeto(d.acrescimos).segundo_tempo_prorrogacao),
    },
    data: texto(d.data_hora), timezone: texto(d.timezone), estadio: texto(objeto(d.estadio).nome), cidade: texto(objeto(d.estadio).cidade),
    mandante, visitante, placar: { mandante: numero(placar.mandante), visitante: numero(placar.visitante) } };
}
export function mapPreJogo(d: Registro) {
  const e = objeto(d.escalacoes);
  const lado = (nome: string) => { const p = objeto(e[nome]); return { provavel: escalacao(p.provavel), confirmada: escalacao(p.confirmada) }; };
  return { partida: partida(d), escalacoesDisponiveis: d.escalacoes != null,
    escalacoes: { mandante: lado('mandante'), visitante: lado('visitante') },
    desfalquesInformados: d.desfalques != null,
    desfalques: lista(d.desfalques).map(p => ({ atleta: participante(p.atleta), equipe: equipe(p.time), situacao: texto(p.situacao), motivo: texto(p.motivo), atualizadoEm: texto(p.atualizado_em) })) };
}
const periodos = ['pre-jogo', 'primeiro-tempo', 'intervalo', 'segundo-tempo', 'prorrogacao-primeiro-tempo', 'prorrogacao-intervalo', 'prorrogacao-segundo-tempo', 'disputa-penaltis', 'encerrado'];
const aliases: Record<string, string> = { 'first-half': 'primeiro-tempo', 'half-time': 'intervalo', 'second-half': 'segundo-tempo' };
export function mapEventos(d: Registro, e: Registro): EventoSumario[] {
  const result: EventoSumario[] = [];
  for (const lado of ['mandante', 'visitante']) {
    const p = objeto(objeto(e.eventos)[lado]), cartoes = objeto(p.cartoes);
    const grupos: [EventoSumario['tipo'], unknown][] = [['GOL', p.gols], ['CARTAO_AMARELO', cartoes.amarelo], ['CARTAO_VERMELHO', cartoes.vermelho], ['SUBSTITUICAO', p.substituicoes], ['VAR', p.var]];
    for (const [tipo, rows] of grupos) for (const row of lista(rows)) {
      const minuto = numero(row.minuto), acrescimo = numero(row.minuto_adicional);
      result.push({ tipo, periodo: texto(row.periodo), tempo: { minuto, acrescimo,
        exibicao: minuto === null ? null : `${minuto}${acrescimo === null ? '' : '+' + acrescimo}'` },
        equipe: equipe(d[lado]), jogador: participante(row.atleta), assistencia: participante(row.atleta_assistencia),
        jogadorSai: participante(row.sai), jogadorEntra: participante(row.entra), comissaoTecnica: participante(row.comissao_tecnica),
        comentarios: texto(row.descricao), origem: { tipo, detalhe: texto(row.tipo_gol ?? row.motivo ?? row.tipo) } });
    }
  }
  const ordem = (p: string | null) => { const i = periodos.indexOf(p ?? ''); return i < 0 ? periodos.length : i; };
  return result.sort((a, b) => ordem(a.periodo) - ordem(b.periodo) || (a.tempo.minuto ?? -1) - (b.tempo.minuto ?? -1) || (a.tempo.acrescimo ?? 0) - (b.tempo.acrescimo ?? 0));
}
export function mapSumario(d: Registro, e: Registro, l: Registro) {
  return { partida: partida(d), eventosDisponiveis: e.eventos != null, eventos: mapEventos(d, e), narrativaDisponivel: l.lances != null,
    narrativa: lista(l.lances).map(p => ({ idExterno: numero(p.id), tipo: texto(p.tipo), periodo: aliases[String(p.periodo)] ?? texto(p.periodo),
      periodoOriginal: texto(p.periodo), minuto: numero(p.minuto), segundo: numero(p.segundo), acrescimo: numero(p.minuto_adicional),
      titulo: texto(p.titulo), texto: texto(p.texto), equipe: p.time == null ? null : equipe(p.time), atleta: participante(p.atleta), geradoEm: texto(p.gerado_em) })) };
}
export function mapFormacao(d: Registro) {
  const pre = mapPreJogo(d);
  const lado = (nome: 'mandante' | 'visitante') => {
    const e = pre.escalacoes[nome], escolhida = e.confirmada ?? e.provavel;
    return { ...pre.partida[nome], disponivel: escolhida !== null, tipoEscalacao: e.confirmada ? 'CONFIRMADA' : e.provavel ? 'PROVAVEL' : null,
      formacao: escolhida?.formacao ?? null, treinador: escolhida?.treinador ?? null, titulares: escolhida?.titulares ?? [], reservas: escolhida?.reservas ?? [], atualizadoEm: escolhida?.atualizadoEm ?? null };
  };
  return { partida: { idExterno: numero(d.id), fornecedor: 'API_FUTEBOL_V2' as const }, mandante: lado('mandante'), visitante: lado('visitante'), substituicoes: mapEventos(d, d).filter(e => e.tipo === 'SUBSTITUICAO') };
}
const campos: Record<keyof EstatisticasEquipe, string> = {
  finalizacoesNoGol: 'finalizacoes_no_gol', finalizacoesFora: 'finalizacoes_fora', finalizacoes: 'finalizacoes', finalizacoesBloqueadas: 'finalizacoes_bloqueadas',
  finalizacoesDentroArea: 'chutes_de_dentro', finalizacoesForaArea: 'chutes_de_fora', faltas: 'faltas', escanteios: 'escanteios', impedimentos: 'impedimentos',
  posseBola: 'posse_de_bola', cartoesAmarelos: 'cartoes_amarelos', cartoesVermelhos: 'cartoes_vermelhos', defesasGoleiro: 'defesas_goleiro',
  passes: 'passes', passesCertos: 'passes_certos', precisaoPasses: 'precisao_passes', golsEsperados: 'gols_esperados', golsEvitados: 'gols_evitados',
};
// Contrato interno fechado: novos atributos do fornecedor não se tornam campos públicos automaticamente.
const metricasAtleta = `minutos_jogados nota nota_publico gols gols_de_penalti gols_sem_penalti gols_contra assistencias
finalizacoes finalizacoes_no_gol finalizacoes_fora finalizacoes_bloqueadas finalizacoes_dentro_area finalizacoes_fora_area finalizacoes_cabeca
grandes_chances_criadas grandes_chances_perdidas passes passes_certos precisao_passes passes_chave passes_ultimo_terco passes_ultimo_terco_certos
cruzamentos cruzamentos_certos bolas_longas bolas_longas_certas desarmes desarmes_ganhos interceptacoes bloqueios cortes duelos duelos_ganhos
duelos_aereos duelos_aereos_ganhos duelos_terrestres duelos_terrestres_ganhos dribles dribles_certos dribles_sofridos
cartoes_amarelos cartoes_amarelos_segundo cartoes_vermelhos faltas_cometidas faltas_sofridas impedimentos gols_esperados assistencias_esperadas
gols_esperados_no_gol toques toques_area_adversario penaltis_sofridos penaltis_cometidos penaltis_convertidos penaltis_perdidos`.split(/\s+/);
const metricasGoleiro = 'defesas finalizacoes_sofridas gols_sofridos gols_evitados penaltis_defendidos saidas reposicoes socos'.split(' ');
function metricas(p: Registro, campos: string[]): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const key of campos) result[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = numero(p[key]);
  return result;
}
export function mapEstatisticas(d: Registro, s: Registro) {
  const lado = (nome: 'mandante' | 'visitante') => {
    const p = objeto(s[nome]), totais = objeto(p.totais), eq = equipe(d[nome]);
    if (p.time != null && equipe(p.time).idExterno !== eq.idExterno) throw new BadGatewayException('Equipe divergente nas estatísticas');
    const estatisticas = Object.fromEntries(Object.entries(campos).map(([destino, origem]) => [destino, numero(totais[origem])])) as unknown as EstatisticasEquipe;
    const porTempo = objeto(totais.por_tempo);
    return { ...eq, disponivel: p.totais != null, estatisticas,
      porTempo: Object.fromEntries(['primeiro_tempo', 'segundo_tempo'].map(tempo => { const t = objeto(porTempo[tempo]); return [tempo === 'primeiro_tempo' ? 'primeiroTempo' : 'segundoTempo', { escanteios: numero(t.escanteios), cartoes: numero(t.cartoes) }]; })),
      atletas: lista(p.atletas).map(a => ({ atleta: { ...participante(a.atleta)!, foto: texto(objeto(a.atleta).foto) },
        posicaoCadastral: null, funcaoPartida: posicao(a), numero: numero(a.numero_camisa), titular: booleano(a.titular), goleiro: booleano(a.goleiro),
        estatisticas: metricas(a, metricasAtleta),
        goleiroEstatisticas: a.goleiro_stats == null ? null : metricas(registro(a.goleiro_stats), metricasGoleiro) })) };
  };
  return { partida: { idExterno: numero(d.id), fornecedor: 'API_FUTEBOL_V2' as const }, mandante: lado('mandante'), visitante: lado('visitante') };
}
