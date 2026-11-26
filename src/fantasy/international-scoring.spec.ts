import { mapPreJogo, mapEstatisticas } from './api-futebol-v2.mapper';
import { simular } from './international-scoring';

const player = (id: number) => ({ id, nome: String(id) });
const detalhe = { id: 1248, status: 'finalizado', mandante: player(10), visitante: player(20),
  placar: { mandante: 2, visitante: 0 }, escalacoes: { mandante: { confirmada: {
    titulares: [player(1), player(2)], reservas: [player(3), player(4)] } } } };
const pre = mapPreJogo(detalhe);
const stats = mapEstatisticas(detalhe, { mandante: { atletas: [
  { atleta: player(1), gols: 1 }, { atleta: player(2), gols: 0 },
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
