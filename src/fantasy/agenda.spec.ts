import { ConfigService } from '@nestjs/config';
import { ApiFutebolV2Client } from './api-futebol-v2.client';
import { consultarAgenda, mapAgenda } from './agenda';
import { FantasyService } from './fantasy.service';
import { readFileSync } from 'fs';
import { join } from 'path';
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/api-futebol-v2', name + '.json'), 'utf8'));
const contexto = fixture('contexto');
const rodadas = fixture('rodadas');
const rodada34 = fixture('rodada34');

describe('Agenda V2', () => {
  const mock = () => ({ campeonato: jest.fn().mockResolvedValue(contexto), rodadas: jest.fn().mockResolvedValue({ itens: rodadas }), rodada: jest.fn().mockResolvedValue(rodada34) });
  it('consulta temporada e rodada reais, preserva placares e ordena por instante', async () => {
    const client = mock();
    const result = await consultarAgenda(client as unknown as ApiFutebolV2Client, '2026', '34');
    expect(result.partidas).toHaveLength(10);
    expect(client.rodada).toHaveBeenCalledWith(34);
    expect(result.partidas[0]).toMatchObject({ fixtureId: 335, status: 'ENCERRADA', dataHora: '2026-11-02T20:00:00-03:00', placar: { mandante: 2, visitante: 1 } });
    expect(result.partidas.find(p => p.fixtureId === 340)).toMatchObject({ status: 'AGENDADA', placar: { mandante: null, visitante: null } });
  });
  it('resolve 34 apesar da pendência da rodada 21', async () => {
    expect((await consultarAgenda(mock() as unknown as ApiFutebolV2Client, '2026')).rodada).toBe(34);
  });
  it.each([['', '34'], ['2026', '0'], ['2026', '39'], ['2026', '1.2'], ['NaN', '1'], ['2026', ['34']]])('rejeita parâmetros inválidos %s %s', async (ano, rodada) => {
    const client = mock();
    await expect(consultarAgenda(client as unknown as ApiFutebolV2Client, ano as string, rodada as string)).rejects.toMatchObject({ status: 400 });
    expect(client.campeonato).not.toHaveBeenCalled();
  });
  it('rejeita outra temporada sem consultar jogos', async () => {
    const client = mock();
    await expect(consultarAgenda(client as unknown as ApiFutebolV2Client, '2025', '34')).rejects.toMatchObject({ status: 404 });
    expect(client.rodada).not.toHaveBeenCalled();
  });
  it('retorna lista vazia sem inventar partidas', () => {
    expect(mapAgenda({ rodada: 34, partidas: [] }, 2026, 34, 38).partidas).toEqual([]);
  });
  it.each([['andamento', 'EM_ANDAMENTO'], ['adiado', 'ADIADA'], ['cancelado', 'CANCELADA'], ['finalizado', 'ENCERRADA']])('normaliza %s e preserva zero e nulos', (status, expected) => {
    const p = { ...rodada34.partidas[0], status, data_hora: null, placar: { mandante: 0, visitante: null }, mandante: { nome: 'Time' } };
    expect(mapAgenda({ rodada: 34, partidas: [p] }, 2026, 34, 38).partidas[0]).toMatchObject({ status: expected, dataHora: null, mandante: { id: null, escudo: null }, placar: { mandante: 0, visitante: null } });
  });
  it('ordena UTC e offsets e coloca datas desconhecidas ao final', () => {
    const a = rodada34.partidas[0];
    const partidas = [ { ...a, id: 1, data_hora: null }, { ...a, id: 2, data_hora: '2026-11-03T01:00:00Z' }, { ...a, id: 3, data_hora: '2026-11-02T20:00:00-03:00' } ];
    expect(mapAgenda({ rodada: 34, partidas }, 2026, 34, 38).partidas.map(p => p.fixtureId)).toEqual([3, 2, 1]);
  });
  it('rejeita identidade divergente e data sem fuso', () => {
    for (const p of [{ ...rodada34.partidas[0], campeonato: { id: 7 } }, { ...rodada34.partidas[0], data_hora: '2026-11-03T12:00:00' }]) expect(() => mapAgenda({ rodada: 34, partidas: [p] }, 2026, 34, 38)).toThrow();
  });
  it('propaga indisponibilidade do provedor', async () => {
    const client = mock(); client.rodada.mockRejectedValue(new Error('indisponível'));
    await expect(consultarAgenda(client as unknown as ApiFutebolV2Client, '2026', '34')).rejects.toThrow('indisponível');
  });
  it('usa exatamente o fixtureId aceito pela Central', async () => {
    const client = { ...mock(), detalhe: jest.fn().mockResolvedValue({ ...rodada34.partidas[0], temporada: contexto.temporada_atual }) };
    const service = new FantasyService(client as unknown as ApiFutebolV2Client);
    const agenda = await service.agenda('2026', '34');
    expect((await service.preJogo(String(agenda.partidas[0].fixtureId))).partida.idExterno).toBe(agenda.partidas[0].fixtureId);
    expect(client.detalhe).toHaveBeenCalledWith(335);
  });
  it('reutiliza autenticação, cache e agrupa chamadas simultâneas', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: rodada34 }), { status: 200 }));
    try {
      const client = new ApiFutebolV2Client(new ConfigService({ API_FUTEBOL_V2_KEY: 'teste' }));
      await Promise.all([client.rodada(34), client.rodada(34)]); await client.rodada(34);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('/campeonatos/1/rodadas/34?timezone=America%2FSao_Paulo');
    } finally { fetchMock.mockRestore(); }
  });
});
