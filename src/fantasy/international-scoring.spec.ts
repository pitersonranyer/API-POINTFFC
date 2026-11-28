import { mapPreJogo, mapEstatisticas, mapEventos } from './api-futebol-v2.mapper';
import { simular } from './international-scoring';

const player = (id: number) => ({ id, nome: String(id) });
const detalhe = { id: 1248, status: 'finalizado', mandante: player(10), visitante: player(20),
  placar: { mandante: 2, visitante: 0 }, escalacoes: { mandante: { confirmada: {
    titulares: [player(1), player(2)], reservas: [player(3), player(4)] } } } };
const pre = mapPreJogo(detalhe);
const stats = mapEstatisticas(detalhe, { mandante: { atletas: [
  { atleta: player(1), gols: 1, minutos_jogados: 90 }, { atleta: player(2), gols: 0 },
  { atleta: player(3), minutos_jogados: 5, faltas_cometidas: 2 },
  { atleta: player(4), minutos_jogados: 0, cartoes_amarelos: 1 },
  { atleta: player(99), gols: 5 }] } });
const result = () => simular(pre, stats, [], '2026-11-25');
it('soma titulares e substituto, inclui cartão de banco apenas na média e separa ID divergente', () => {
  const c = result().clubes[0];
  expect(c.atletas.map(a => a.pontuacao)).toEqual([8,0,-0.6,null]);
  expect(c).toMatchObject({ participantes: 3, calculados: 3, incompletos: 3, pontuacaoTotal: 7.4,
    tecnico: { cartoesBanco: -1, numerador: 6.4, denominador: 11, bonusVitoria: 1, pontuacao: 1.58 } });
  expect(result().pendencias).toContain('ID_FORA_DA_ESCALACAO:99');
  expect(result().statusPontuacao).toBe('PROVISORIO');
});
it('condiciona SG ao cadastro e preserva scout nulo', () => {
  const cadastro = structuredClone(pre);
  cadastro.escalacoes.mandante.confirmada!.titulares[0].posicaoCadastral = { categoria: 'LAT', nome: null, codigo: null };
  const [lateral, semPosicao] = simular(cadastro, stats, [], '').clubes[0].atletas;
  expect(lateral.pontuacao).toBe(13);
  expect(semPosicao.scouts.find(s => s.codigo === 'SG')?.pontos).toBeNull();
});
it('preserva o estado pré-jogo mesmo com estatísticas antigas', () => {
  const antes = mapPreJogo({ ...detalhe, status: 'agendado' });
  expect(simular(antes, stats, [], '')).toMatchObject({ statusPontuacao: 'NAO_INICIADA', ranking: [] });
});

function defesa(minutos: number[], gols: number[], troca?: number, direto?: number, placar = gols.length) {
  const g = (id: number) => ({ ...player(id), posicao_categoria: 'GOL' });
  const d = { ...detalhe, placar: { mandante: 2, visitante: placar }, escalacoes: {
    mandante: { confirmada: { titulares: [g(1)], reservas: [g(2)] } },
  } };
  const linhas = minutos.map((m, i) => ({ atleta: g(i + 1), gols: 0, goleiro: true, posicao_categoria: 'GOL',
    minutos_jogados: m, goleiro_stats: i === 0 && direto !== undefined ? { gols_sofridos: direto } : null }));
  const eventos = { visitante: { gols: gols.map(minuto => ({ minuto, periodo: 'segundo-tempo', atleta: player(10) })) },
    mandante: { substituicoes: troca === undefined ? [] : [{ periodo: 'segundo-tempo', minuto: troca, sai: g(1), entra: g(2) }] } };
  return simular(mapPreJogo(d), mapEstatisticas(d, { mandante: { atletas: linhas } }), mapEventos(d, { eventos }), '').clubes[0];
}

it('totaliza SG somente com atuação e identifica os dois GS de um goleiro integral', () => {
  const inter = defesa([90, 0], []);
  expect(inter.atletas.map(a => a.pontuacao)).toEqual([5, null]);
  expect(inter.tecnico.pontuacao).toBe(1.45);
  const comGols = defesa([90, 0], [11, 28]);
  expect(comGols.pontuacaoTotal).toBe(-2);
  expect(comGols.tecnico.pontuacao).toBe(-0.18);
  expect(defesa([90, 0], [11, 28], undefined, 0).atletas[0].scouts.find(s => s.codigo === 'GS'))
    .toMatchObject({ quantidade: 0, origem: 'DIRETO' });
});

it('atribui o GS conforme o instante da troca e recalcula após correção', () => {
  expect(defesa([60, 30], [11, 28], 15).atletas.map(a => a.pontuacao)).toEqual([-1, -1]);
  expect(defesa([60, 30], [16, 28], 15).atletas.map(a => a.pontuacao)).toEqual([0, -2]);
  expect(defesa([60, 30], [], 15).atletas.map(a => a.pontuacao)).toEqual([5, 5]);
});

it('preserva GS nulo com troca ambígua, eventos duplicados ou cobertura incompleta', () => {
  for (const c of [defesa([60, 30], [15], 15), defesa([60, 30], [11, 11], 15),
    defesa([60, 30], [28], 15, undefined, 2), defesa([60, 30], [28])]) {
    for (const a of c.atletas) expect(a.scouts.find(s => s.codigo === 'GS')?.quantidade).toBeNull();
  }
});
