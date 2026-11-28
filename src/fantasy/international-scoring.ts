import type { mapPreJogo, mapEstatisticas, mapEventos } from './api-futebol-v2.mapper';

type Pre = ReturnType<typeof mapPreJogo>;
type Stats = ReturnType<typeof mapEstatisticas>;
type Row = Stats['mandante']['atletas'][number];
type Side = 'mandante' | 'visitante';
type Events = ReturnType<typeof mapEventos>;

// Pesos em décimos para somar exatamente antes de calcular a média.
const weights = { G: 80, A: 50, FT: 30, FD: 12, FF: 8, FS: 5, PS: 10, I: -1, PP: -40,
  DS: 15, SG: 50, DE: 13, DP: 70, GC: -30, CV: -30, CA: -10, FC: -3, PC: -10, GS: -10 };
type Code = keyof typeof weights;

// Os minutos do fornecedor reiniciam a cada período.
function instante(e: Events[number]) {
  const periodo = ['primeiro-tempo', 'segundo-tempo', 'prorrogacao-primeiro-tempo', 'prorrogacao-segundo-tempo'].indexOf(e.periodo ?? '');
  const minuto = e.tempo.minuto, adicional = e.tempo.acrescimo ?? 0;
  if (periodo < 0 || minuto === null || !Number.isInteger(minuto) || minuto < 0 || minuto > 120 ||
      !Number.isInteger(adicional) || adicional < 0 || adicional > 99) return null;
  return periodo * 20000 + minuto * 100 + adicional;
}

function golsNoPeriodo(row: Row, titular: boolean, clube: number | null, sofridos: number, eventos: Events,
  goleirosEmCampo: Row[], encerrada: boolean) {
  const id = row.atleta.idExterno;
  const gols = eventos.filter(e => e.tipo === 'GOL' && e.equipe.idExterno !== clube && e.periodo !== 'disputa-penaltis');
  if (gols.length > sofridos || (sofridos > 0 && gols.length !== sofridos)) return null;
  if (sofridos === 0) return 0;
  const chaves = gols.map(e => JSON.stringify([e.periodo, e.tempo.minuto, e.tempo.acrescimo, e.jogador?.idExterno]));
  if (new Set(chaves).size !== gols.length) return null;
  const locais = eventos.filter(e => e.equipe.idExterno === clube);
  const trocas = locais.filter(e => e.tipo === 'SUBSTITUICAO');
  const entradas = trocas.filter(e => e.jogadorEntra?.idExterno === id);
  const saidas = trocas.filter(e => e.jogadorSai?.idExterno === id);
  // Uma expulsão pode transferir a função para um jogador de linha.
  if ((row.estatisticas.cartoesVermelhos ?? 0) > 0 || locais.some(e => e.tipo === 'CARTAO_VERMELHO' && e.jogador?.idExterno === id)) return null;
  if (entradas.length !== Number(!titular) || saidas.length > 1) return null;
  const envolveGoleiro = (outro: number | null | undefined) => goleirosEmCampo.some(r => r.atleta.idExterno === outro);
  if (entradas.some(e => !envolveGoleiro(e.jogadorSai?.idExterno)) ||
      saidas.some(e => !envolveGoleiro(e.jogadorEntra?.idExterno))) return null;
  if (!entradas.length && !saidas.length) {
    // Sem troca, exigir evidência positiva de que cobriu toda a partida.
    const duracao = eventos.some(e => e.periodo?.startsWith('prorrogacao')) ? 120 : 90;
    return encerrada && goleirosEmCampo.length === 1 && row.estatisticas.minutosJogados === duracao ? sofridos : null;
  }
  const inicio = entradas.length ? instante(entradas[0]) : -Infinity;
  const fim = saidas.length ? instante(saidas[0]) : Infinity;
  // Com vários goleiros, todos precisam pertencer à mesma sequência de trocas.
  if (goleirosEmCampo.length !== 2 || trocas.filter(e => envolveGoleiro(e.jogadorEntra?.idExterno) ||
    envolveGoleiro(e.jogadorSai?.idExterno)).length !== 1) return null;
  if (inicio === null || fim === null || inicio >= fim) return null;
  const tempos = gols.map(instante);
  if (tempos.some(t => t === null || t === inicio || t === fim)) return null;
  return tempos.filter(t => t! > inicio && t! < fim).length;
}

function scouts(row: Row | undefined, position: string | null = null, sg: number | null = null, gs: number | null = null, direto = false) {
  const s = row?.estatisticas ?? {};
  // Segundo amarelo cancela os dois CA. Vermelho de origem incerta mantém CA pendente.
  let yellow = s.cartoesAmarelos;
  if ((s.cartoesVermelhos ?? 0) > 0 && yellow !== null && yellow > 0) {
    yellow = s.cartoesAmarelosSegundo == null ? null : s.cartoesAmarelosSegundo > 0 ? 0 : yellow;
  }
  const values: Record<Code, number | null> = {
    G: s.gols, A: s.assistencias, FT: null, FD: null, FF: null, FS: s.faltasSofridas,
    PS: s.penaltisSofridos, I: s.impedimentos, PP: s.penaltisPerdidos, DS: null,
    SG: sg,
    DE: position === 'GOL' && row?.goleiroEstatisticas?.penaltisDefendidos === 0 ? row.goleiroEstatisticas.defesas : null,
    DP: row?.goleiroEstatisticas?.penaltisDefendidos ?? null, GC: s.golsContra,
    CV: s.cartoesVermelhos, CA: yellow, FC: s.faltasCometidas, PC: s.penaltisCometidos, GS: gs,
  };
  return (Object.keys(weights) as Code[]).map(codigo => {
    const v = values[codigo];
    const quantidade = Number.isSafeInteger(v) && v !== null && v >= 0 ? v : null;
    const origem = codigo === 'SG' || codigo === 'GS' ? {
      origem: quantidade === null ? 'INDISPONIVEL' : codigo === 'GS' && direto ? 'DIRETO' : 'DERIVADO',
    } : {};
    return { codigo, quantidade, ...origem, valor: weights[codigo] / 10,
      pontos: quantidade === null ? null : quantidade * weights[codigo] / 10 };
  });
}

function sum(values: (number | null)[]) {
  const known = values.filter((p): p is number => p !== null);
  return known.length ? known.reduce((n, p) => n + Math.round(p * 10), 0) / 10 : null;
}

export function simular(pre: Pre, stats: Stats, events: Events, calculadoEm: string) {
  const partida = pre.partida;
  const live = ['EM_ANDAMENTO', 'INTERVALO'].includes(partida.status);
  const ended = partida.status === 'ENCERRADA';
  const active = live || ended;
  const clubes = (['mandante', 'visitante'] as Side[]).map(side => {
    const equipe = partida[side];
    const lineup = pre.escalacoes[side].confirmada;
    const rows = stats[side].atletas;
    const roster = [...(lineup?.titulares ?? []), ...(lineup?.reservas ?? [])];
    const ids = new Set(roster.map(p => p.idExterno));
    const pendencias: string[] = [];
    if (!lineup) pendencias.push('ESCALACAO_NAO_CONFIRMADA');
    for (const row of rows) if (!ids.has(row.atleta.idExterno))
      pendencias.push('ID_FORA_DA_ESCALACAO:' + row.atleta.idExterno);
    const opponent = side === 'mandante' ? 'visitante' : 'mandante';
    const conceded = partida.placar[opponent];
    const goleirosEmCampo = rows.filter(r => r.goleiro === true && (r.estatisticas.minutosJogados ?? 0) > 0);
    const placarValido = conceded !== null && Number.isSafeInteger(conceded) && conceded >= 0;
    const golAdversario = events.some(e => e.tipo === 'GOL' && e.periodo !== 'disputa-penaltis' && e.equipe.idExterno === partida[opponent].idExterno);
    const atletas = roster.map(player => {
      const matches = rows.filter(r => r.atleta.idExterno === player.idExterno);
      const row = matches.length === 1 ? matches[0] : undefined;
      const minutos = row?.estatisticas.minutosJogados ?? null;
      const titular = lineup!.titulares.includes(player);
      const entrou = events.some(e => e.tipo === 'SUBSTITUICAO' && e.equipe.idExterno === equipe.idExterno && e.jogadorEntra?.idExterno === player.idExterno);
      const participou = active && (titular || entrou || (minutos !== null && minutos > 0));
      const cadastro = player.posicaoCadastral?.categoria ?? null;
      const goleiroIdentificado = cadastro === 'GOL' || (cadastro === null && row?.goleiro === true &&
        row.funcaoPartida.categoria === 'GOL' && player.funcaoPartida.categoria === 'GOL');
      const posicaoSG = cadastro ?? (goleiroIdentificado ? 'GOL' : null);
      const atuacaoConfirmada = entrou || (minutos !== null && minutos > 0) ||
        events.some(e => e.tipo === 'SUBSTITUICAO' && e.equipe.idExterno === equipe.idExterno && e.jogadorSai?.idExterno === player.idExterno);
      let sg: number | null = null;
      if (placarValido && conceded > 0) sg = 0;
      else if (placarValido && !golAdversario && atuacaoConfirmada && posicaoSG &&
        ['GOL', 'LAT', 'ZAG', 'MEI', 'ATA'].includes(posicaoSG)) sg = Number(['GOL', 'LAT', 'ZAG'].includes(posicaoSG));
      const direto = row?.goleiroEstatisticas?.golsSofridos;
      let gs: number | null = null;
      if (goleiroIdentificado && row && atuacaoConfirmada) {
        gs = direto ?? (placarValido ? golsNoPeriodo(row, titular, equipe.idExterno, conceded, events, goleirosEmCampo, ended) : null);
      }
      const detalhes = scouts(row, cadastro, sg, gs, direto != null);
      const pendenciasAtleta = participou ? detalhes.filter(s => s.quantidade === null).map(s => s.codigo as string) : [];
      if (participou && !row) pendenciasAtleta.push('ESTATISTICAS_SEM_VINCULO_UNICO');
      if (participou && !player.posicaoCadastral) pendenciasAtleta.push('POSICAO_CADASTRAL');
      const total = participou && row ? sum(detalhes.filter(s => s.codigo !== 'SG' || s.quantidade !== 0 || player.posicaoCadastral !== null).map(s => s.pontos)) : null;
      return { id: player.idExterno, nome: player.nome, clubeId: equipe.idExterno, posicao: player.posicaoCadastral,
        funcaoPartida: player.funcaoPartida, numero: player.numero, titular, minutos, participou,
        scouts: participou ? detalhes : [], pontuacao: total, incompleta: pendenciasAtleta.length > 0, pendencias: pendenciasAtleta };
    });
    const participantes = atletas.filter(a => a.participou);
    const total = sum(participantes.map(a => a.pontuacao));
    let cartoesBanco = 0;
    for (const a of atletas.filter(a => active && !a.participou)) {
      const r = rows.find(r => r.atleta.idExterno === a.id);
      const cards = scouts(r).filter(s => ['CV', 'CA'].includes(s.codigo));
      const eventosAtleta = events.filter(e => e.equipe.idExterno === equipe.idExterno && e.jogador?.idExterno === a.id && !e.comissaoTecnica);
      for (const card of cards) {
        const tipo = card.codigo === 'CV' ? 'CARTAO_VERMELHO' : 'CARTAO_AMARELO';
        const quantidade = eventosAtleta.filter(e => e.tipo === tipo).length;
        if (card.pontos !== null) cartoesBanco += card.pontos;
        else if (quantidade && (card.codigo === 'CV' || !eventosAtleta.some(e => e.tipo === 'CARTAO_VERMELHO'))) cartoesBanco += quantidade * card.valor;
      }
      if (cards.some(s => s.pontos === null)) pendencias.push('CARTOES_BANCO:' + a.id);
    }
    const gols = partida.placar[side];
    if (ended && gols !== null) {
      const golsIndividuais = sum(participantes.map(a => a.scouts.find(s => s.codigo === 'G')?.quantidade ?? null));
      if (golsIndividuais !== gols) pendencias.push('CONFERIR_GOLS_INDIVIDUAIS_E_GOLS_CONTRA');
    }
    const bonus = ended && (gols === null || conceded === null) ? null : Number(ended && gols! > conceded!);
    const numerador = total === null ? null : sum([total, cartoesBanco]);
    return { ...equipe, atletas, pontuacaoTotal: total, participantes: participantes.length,
      calculados: participantes.filter(a => a.pontuacao !== null).length, incompletos: participantes.filter(a => a.incompleta).length,
      pendencias, tecnico: { treinador: lineup?.treinador ?? null, numerador, denominador: 11, cartoesBanco, bonusVitoria: bonus,
        pontuacao: numerador === null || bonus === null ? null : Number((numerador / 11 + bonus).toFixed(2)), provisoria: true } };
  });
  const ranking = clubes.flatMap(c => c.atletas).filter(a => a.pontuacao !== null)
    .sort((a,b) => b.pontuacao! - a.pontuacao! || a.id! - b.id!).map(a => ({ id: a.id, nome: a.nome, clubeId: a.clubeId, pontuacao: a.pontuacao }));
  let statusPontuacao = 'PENDENTE';
  if (['AGENDADA','PRE_JOGO'].includes(partida.status)) statusPontuacao = 'NAO_INICIADA';
  if (ranking.length) statusPontuacao = ended ? 'PROVISORIO' : 'AO_VIVO';
  return { partida, statusPontuacao, calculadoEm, atualizadoEmFornecedor: null, clubes, ranking,
    pendencias: ['CONSOLIDACAO_NAO_INFORMADA', 'SEMANTICA_DESARMES', 'CLASSIFICACAO_FINALIZACOES', ...clubes.flatMap(c => c.pendencias)] };
}
