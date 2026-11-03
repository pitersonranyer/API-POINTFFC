// Recortes dos formatos e valores observados na homologação de 02/11/2026.
// Usados exclusivamente pelos testes; nunca como fallback da aplicação.
export const finalizada = {
  id: 321, campeonato: { id: 1, nome: 'Campeonato Brasileiro' }, temporada: { nome: 'Campeonato Brasileiro 2026' },
  fase: { nome: 'Fase única' }, rodada: 33, status: 'finalizado', periodo: 'encerrado',
  data_hora: '2026-10-28T22:30:00+00:00', timezone: 'UTC', estadio: { nome: 'Maracanã' },
  mandante: { id: 9, nome: 'Fluminense', escudo: null }, visitante: { id: 3, nome: 'Internacional', escudo: null },
  placar: { mandante: 2, visitante: 1 }, desfalques: [],
  escalacoes: { mandante: {
    confirmada: { formacao: '4-3-3', tecnico: { id: 238, nome: 'Marcão', foto: null }, atualizado_em: '2026-11-02T15:31:18+00:00',
      titulares: [{ id: 201, nome: 'Savarino', numero_camisa: 11, foto: null, posicao: 'Atacante', posicao_codigo: 'ATA', posicao_categoria: 'ATA', grid: '4:3', coordenada: { linha: 4, coluna: 3 } }], reservas: [] },
    provavel: { formacao: '4-3-3', titulares: [{ id: 201, nome: 'Savarino', posicao: 'Meio-campo', posicao_codigo: 'ATA' }], reservas: [] },
  }, visitante: { confirmada: null, provavel: null } },
};
export const futura = { ...finalizada, id: 340, status: 'agendado', periodo: null, escalacoes: null,
  placar: null, estadio: null, rodada: null,
  data_hora: '2026-11-03T22:30:00+00:00', mandante: { id: 13, nome: 'Chapecoense' }, visitante: { id: 17, nome: 'Mirassol' },
  desfalques: [{ atleta: { id: 1553, nome: 'Bruno Santos' }, time: { id: 17, nome: 'Mirassol' }, situacao: 'suspenso', motivo: 'Suspenso (cartão vermelho)' },
    { atleta: { id: 506, nome: 'Garcez' }, time: { id: 13, nome: 'Chapecoense' }, situacao: 'duvida', motivo: 'Inativo' }],
};
export const eventos = { id: 321, eventos: {
  mandante: { gols: [{ minuto: 45, minuto_adicional: 7, periodo: 'segundo-tempo', atleta: { id: 189, nome: 'Lucho Acosta' }, atleta_assistencia: null }] },
  visitante: { gols: [{ minuto: 0, minuto_adicional: null, periodo: 'segundo-tempo', atleta: { id: 102, nome: 'Alan Patrick' }, atleta_assistencia: { id: 560, nome: 'Matheus Bahia' } }],
    substituicoes: [{ minuto: null, minuto_adicional: null, periodo: 'intervalo', sai: { id: 97, nome: 'Bernabei' }, entra: { id: 100, nome: 'Vitinho' } }] },
} };
export const lances = { id: 321, lances: [{ id: 60365, tipo: 'goal', periodo: 'second-half', minuto: 45, segundo: 29, minuto_adicional: 6, texto: 'Gol marcado por Lucho Acosta', time: null, atleta: null }] };
export const estatisticas = { id: 321, mandante: { time: finalizada.mandante,
  totais: { posse_de_bola: 67, passes: 782, gols_esperados: 1.86, gols_esperados_total: 3.17, interceptacoes: null,
    por_tempo: { primeiro_tempo: { gols: 0, escanteios: 2, cartoes: 0 }, segundo_tempo: { gols: 0, escanteios: 6, cartoes: 2 } } },
  atletas: [{ atleta: { id: 182, nome: 'Fábio' }, posicao: 'Goleiro', titular: true, goleiro: true, minutos_jogados: 90, gols_esperados: null,
    goleiro_stats: { defesas: 4, gols_sofridos: 1, finalizacoes_sofridas: null } }],
}, visitante: null };
