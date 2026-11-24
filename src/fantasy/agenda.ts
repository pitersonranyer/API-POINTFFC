import { BadGatewayException, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiFutebolV2Client, Registro, registro } from './api-futebol-v2.client';

function inteiro(value: unknown, min: number, max: number, nome: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new BadRequestException(`${nome} deve ser inteiro entre ${min} e ${max}`);
  return Number(value);
}
function numero(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadGatewayException('Número inválido na agenda');
  return value;
}
function texto(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new BadGatewayException('Texto inválido na agenda');
  return value;
}
function equipe(value: unknown) {
  const e = value == null ? {} : registro(value);
  return { id: numero(e.id), nome: texto(e.nome), escudo: texto(e.escudo) };
}
function dataHora(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new BadGatewayException('Data inválida na agenda');
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date).replace(' ', 'T');
  const offset = Math.round((Date.parse(parts + 'Z') - (date.getTime() - date.getUTCMilliseconds())) / 60000);
  const abs = Math.abs(offset);
  const fraction = date.getUTCMilliseconds() ? `.${String(date.getUTCMilliseconds()).padStart(3, '0')}` : '';
  return `${parts}${fraction}${offset >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
const estados: Record<string, string> = { agendado: 'AGENDADA', 'pre-jogo': 'PRE_JOGO', andamento: 'EM_ANDAMENTO', finalizado: 'ENCERRADA', adiado: 'ADIADA', cancelado: 'CANCELADA', suspenso: 'INTERROMPIDA', abandonado: 'ABANDONADA', wo: 'RESULTADO_ADMINISTRATIVO' };
export function mapAgenda(data: Registro, temporada: number, rodada: number, totalRodadas: number, campeonatoId = 1, faseId?: number) {
  if (data.rodada !== rodada || !Array.isArray(data.partidas)) throw new BadGatewayException('Rodada inválida na agenda');
  const ids = new Set<number>();
  const partidas = data.partidas.map(value => {
    const p = registro(value);
    if (!Number.isSafeInteger(p.id) || Number(p.id) <= 0 || ids.has(Number(p.id)) || registro(p.campeonato).id !== campeonatoId || p.rodada !== rodada || (faseId !== undefined && registro(p.fase).id !== faseId)) throw new BadGatewayException('Identidade divergente na agenda');
    ids.add(Number(p.id));
    const placar = p.placar == null ? {} : registro(p.placar);
    return { fixtureId: Number(p.id), mandante: equipe(p.mandante), visitante: equipe(p.visitante), dataHora: dataHora(p.data_hora), status: estados[String(p.status)] ?? (p.status == null ? null : 'DESCONHECIDO'), placar: { mandante: numero(placar.mandante), visitante: numero(placar.visitante) } };
  }).sort((a, b) => (a.dataHora === null ? Infinity : Date.parse(a.dataHora)) - (b.dataHora === null ? Infinity : Date.parse(b.dataHora)) || a.fixtureId - b.fixtureId);
  return { fornecedor: 'API_FUTEBOL_V2' as const, competicao: 'Brasileirão Série A', temporada, rodada, totalRodadas, partidas };
}

export async function consultarAgenda(client: ApiFutebolV2Client, ano?: string, numeroRodada?: string, campeonato?: string, fase?: string) {
  if (campeonato === '15') return consultarChampions(client, ano, numeroRodada, fase);
  if ((campeonato !== undefined && campeonato !== '1') || fase !== undefined) throw new BadRequestException('Campeonato ou fase inválida');
  const temporada = inteiro(ano, 1900, 2100, 'temporada');
  const solicitada = numeroRodada === undefined ? undefined : inteiro(numeroRodada, 1, 38, 'rodada');
  const brasileiro = await client.campeonato();
  if (brasileiro.id !== 1) throw new BadGatewayException('Campeonato divergente na agenda');
  if (registro(brasileiro.temporada_atual).ano_inicio !== temporada) throw new NotFoundException('Temporada indisponível: o provedor permite apenas a temporada atual');
  const lista = (await client.rodadas()).itens;
  if (!Array.isArray(lista) || !lista.length) throw new ServiceUnavailableException('Calendário de rodadas indisponível');
  const rodadas = lista.map(registro);
  if (rodadas.some(r => !Number.isInteger(r.rodada) || Number(r.rodada) < 1 || Number(r.rodada) > 38) || new Set(rodadas.map(r => r.rodada)).size !== rodadas.length) throw new BadGatewayException('Calendário de rodadas inválido');
  // Rodadas antigas podem permanecer em andamento por partidas adiadas.
  // Prefere a maior rodada iniciada; nunca usa a próxima partida cronológica.
  const iniciadas = rodadas.filter(r => ['andamento', 'finalizado'].includes(String(r.status)));
  const rodada = solicitada ?? (iniciadas.length ? Math.max(...iniciadas.map(r => Number(r.rodada))) : Math.min(...rodadas.map(r => Number(r.rodada))));
  if (!rodadas.some(r => r.rodada === rodada)) throw new NotFoundException('Rodada não disponível no calendário');
  return mapAgenda(await client.rodada(rodada), temporada, rodada, Math.max(...rodadas.map(r => Number(r.rodada))));
}

function inteiroPositivo(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function consultarChampions(client: ApiFutebolV2Client, ano?: string, rodada?: string, fase?: string) {
  const solicitada = rodada === undefined ? undefined : inteiro(rodada, 1, Number.MAX_SAFE_INTEGER, 'rodada');
  const faseSolicitada = fase === undefined ? undefined : inteiro(fase, 1, Number.MAX_SAFE_INTEGER, 'fase');
  const anoSolicitado = ano === undefined ? undefined : inteiro(ano, 1900, 2100, 'temporada');
  if ((solicitada === undefined) !== (faseSolicitada === undefined)) throw new BadRequestException('Informe rodada e fase juntas');

  const campeonatoId = 15;
  const campeonato = await client.campeonato(campeonatoId);
  if (campeonato.id !== campeonatoId) throw new BadGatewayException('Campeonato divergente na agenda');
  const temporadaAtual = registro(campeonato.temporada_atual);
  const temporada = temporadaAtual.ano_inicio;
  const temporadaNome = texto(temporadaAtual.nome);
  if (!inteiroPositivo(temporada)) throw new BadGatewayException('Temporada inválida na agenda');
  if (anoSolicitado !== undefined && anoSolicitado !== temporada) throw new NotFoundException('Temporada indisponível');

  const lista = (await client.rodadas(campeonatoId, temporada)).itens;
  if (!Array.isArray(lista) || !lista.length) throw new ServiceUnavailableException('Calendário de rodadas indisponível');
  const rodadas = lista.map(item => {
    const r = registro(item);
    const f = registro(r.fase);
    if (!inteiroPositivo(r.rodada) || !inteiroPositivo(f.id)) throw new BadGatewayException('Calendário de rodadas inválido');
    return { rodada: r.rodada, fase: f.id, status: r.status, nome: texto(r.nome), faseNome: texto(f.nome) };
  });
  if (new Set(rodadas.map(r => `${r.fase}/${r.rodada}`)).size !== rodadas.length) throw new BadGatewayException('Calendário de rodadas inválido');

  // Preserve a ordem do calendário e identifique a rodada pelo par fase e número.
  const atual = solicitada === undefined
    ? rodadas.filter(r => ['andamento', 'finalizado'].includes(String(r.status))).at(-1) ?? rodadas[0]
    : rodadas.find(r => r.rodada === solicitada && r.fase === faseSolicitada);
  if (!atual) throw new NotFoundException('Fase ou rodada não disponível no calendário');

  const detalhe = await client.rodada(atual.rodada, campeonatoId, temporada, atual.fase);
  if (registro(detalhe.fase).id !== atual.fase) throw new BadGatewayException('Fase divergente na agenda');
  const total = Math.max(...rodadas.filter(r => r.fase === atual.fase).map(r => r.rodada));
  const indice = rodadas.indexOf(atual);
  const anterior = rodadas[indice - 1];
  const proxima = rodadas[indice + 1];
  return {
    ...mapAgenda(detalhe, temporada, atual.rodada, total, campeonatoId, atual.fase),
    competicao: texto(campeonato.nome_completo) ?? texto(campeonato.nome_popular) ?? 'Champions League',
    campeonatoId,
    champions: {
      temporadaNome,
      fase: atual.fase,
      faseNome: atual.faseNome,
      rodadaNome: atual.nome,
      anterior: anterior ? { rodada: anterior.rodada, fase: anterior.fase } : null,
      proxima: proxima ? { rodada: proxima.rodada, fase: proxima.fase } : null,
    },
  };
}
