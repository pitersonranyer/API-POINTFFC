import { CARTOLA_CLUBES_BSA, vinculoCartola } from '../src/futebol/futebol-cartola';
import { CartolaService } from '../src/cartola/cartola.service';
import { CartolaHttpClient } from '../src/cartola/cartola-http.client';
import { CartolaCacheService } from '../src/cartola/cartola-cache.service';
import { PrismaService } from '../src/prisma/prisma.service';

// IDs confirmados nas respostas Cartola /clubes e /atletas/mercado.
const expected = [[1765,266],[1766,282],[1767,284],[1768,293],[1769,275],[1770,263],[1771,283],[1772,315],[1776,276],[1777,265],[1779,264],[1780,267],[1782,287],[1783,262],[4241,294],[4286,280],[4287,364],[4364,2305],[6684,285],[6685,277]];
describe('Vínculo Cartola exclusivo BSA', () => {
  it.each(expected)('football-data %s corresponde ao clube Cartola %s', (externalId, cartolaClubeId) => {
    expect(vinculoCartola('BSA', externalId)).toEqual({ cartolaClubeId });
  });
  it('mapeia exatamente os 20 clubes sem duplicar IDs Cartola', () => {
    expect(Object.keys(CARTOLA_CLUBES_BSA)).toHaveLength(20);
    expect(new Set(Object.values(CARTOLA_CLUBES_BSA)).size).toBe(20);
  });
  it('BSA desconhecido não recebe associação', () => expect(vinculoCartola('BSA', 999999)).toEqual({}));
  it.each(['PL', 'PD', 'CL'])('não resolve Cartola para %s nem quando o ID é conhecido no mapa BSA', codigo => {
    expect(vinculoCartola(codigo, 1783)).toEqual({});
  });
  it('IDs retornados são compatíveis com clube_id dos atletas pontuados do service atual', async () => {
    const athletes = {
      '1': { clube_id: 262, pontuacao: 2 },
      '2': { clube_id: 264, pontuacao: 3 },
      '3': { clube_id: 282, pontuacao: 4 },
      '4': { clube_id: 266, pontuacao: 5 },
    };
    const prisma = { rodadaProcessamento: { findUnique: jest.fn().mockResolvedValue({ status: 'CONSOLIDADA', pontuados: { atletas: athletes } }) } };
    const http = { get: jest.fn() };
    const service = new CartolaService(http as unknown as CartolaHttpClient, {} as CartolaCacheService, prisma as unknown as PrismaService);
    const result = await service.getScoredAthletes(26, 2026);
    for (const externalId of [1783, 1779, 1766, 1765]) {
      const id = vinculoCartola('BSA', externalId).cartolaClubeId;
      expect(Object.values(result.value.atletas!).filter(athlete => athlete.clube_id === id)).toHaveLength(1);
    }
    expect(http.get).not.toHaveBeenCalled();
  });
});
