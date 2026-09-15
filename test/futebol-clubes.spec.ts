import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapTeam } from '../src/futebol/football-data.normalizer';
import { NOMES_CLUBES_BSA, nomesClube } from '../src/futebol/futebol-clubes';
import { NOMES_CLUBES_INTERNACIONAIS } from '../src/futebol/futebol-clubes-internacionais';
import { FutebolCodigo } from '../src/futebol/futebol-competicoes';
import { vinculoCartola } from '../src/futebol/futebol-cartola';

interface Inventory {
  competitions: { code: FutebolCodigo; season: number; externalIds: number[] }[];
  teams: { externalId: number; nomeOriginal: string; nomeCurtoPersistido: string | null }[];
}
const inventory: Inventory = JSON.parse(readFileSync(join(__dirname, 'fixtures/futebol-clubes-conhecidos.json'), 'utf8'));
const providerTeam = (id: number, name: string, shortName: string | null = null) => ({
  id, name, shortName, tla: 'XXX', crest: 'https://crests.example/team.svg', area: { name: 'Country' },
});

describe('Nomes editoriais por externalId do clube', () => {
  it.each([
    [108, 'FC Internazionale Milano', 'Inter de Milão', 'Inter'],
    [66, 'Manchester United FC', 'Manchester United', 'Manchester United'],
    [524, 'Paris Saint-Germain FC', 'Paris Saint-Germain', 'PSG'],
    [5, 'FC Bayern München', 'Bayern de Munique', 'Bayern'],
    [78, 'Club Atlético de Madrid', 'Atlético de Madrid', 'Atlético'],
    [5527, 'Académico de Viseu FC', 'Académico de Viseu', 'Acad. Viseu'],
    [1912, 'Telstar 1963', 'Telstar', 'Telstar'],
    [1126, 'Lincoln City FC', 'Lincoln City', 'Lincoln City'],
  ])('%s preserva original e aplica os dois nomes editoriais', (id, original, nome, nomeCurto) => {
    expect(mapTeam(providerTeam(id as number, original as string), 'CL')).toMatchObject({ externalId: id, nomeOriginal: original, nome, nomeCurto });
  });

  it.each(['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'PPL', 'DED', 'ELC', 'BSA'] as const)('externalId 66 tem uma definição independente de %s', code => {
    expect(mapTeam(providerTeam(66, 'Nome institucional alterado', 'OUTRO'), code)).toMatchObject({
      nomeOriginal: 'Nome institucional alterado', nome: 'Manchester United', nomeCurto: 'Manchester United',
    });
  });
  it.each([null, 'Curto do provider', 'PSG'])('fallback não infere alias por nome, sigla ou shortName (%s)', shortName => {
    const value = { ...providerTeam(999999, 'Paris Saint-Germain FC', shortName), tla: 'PSG', slug: 'paris-saint-germain' };
    expect(mapTeam(value, 'FL1')).toMatchObject({ nomeOriginal: value.name, nome: value.name, nomeCurto: shortName ?? value.name });
  });
  it('nome original é preservado literalmente mesmo com alias e shortName ausente', () => {
    const original = '  FC Bayern München — nome do provider  ';
    expect(nomesClube(5, original, null)).toEqual({ nomeOriginal: original, nome: 'Bayern de Munique', nomeCurto: 'Bayern' });
  });

  it.each(inventory.competitions)('cobertura completa dos clubes inventariados: $code', competition => {
    const missing = competition.externalIds.filter(id => NOMES_CLUBES_BSA[id] === undefined && NOMES_CLUBES_INTERNACIONAIS[id] === undefined);
    expect(missing).toEqual([]);
  });
  it('167 aliases internacionais e 20 BSA, sem IDs duplicados entre mapas', () => {
    const internationalIds = [...new Set(inventory.competitions.filter(c => c.code !== 'BSA').flatMap(c => c.externalIds))].sort((a, b) => a - b);
    expect(Object.keys(NOMES_CLUBES_INTERNACIONAIS).map(Number).sort((a, b) => a - b)).toEqual(internationalIds);
    expect(internationalIds).toHaveLength(167);
    expect(Object.keys(NOMES_CLUBES_BSA)).toHaveLength(20);
    expect(internationalIds.filter(id => NOMES_CLUBES_BSA[id] !== undefined)).toEqual([]);
  });
  it('clubes compartilhados entre CL e ligas reutilizam o mesmo ID e os mesmos nomes', () => {
    const champions = inventory.competitions.find(c => c.code === 'CL')!;
    let shared = 0;
    for (const competition of inventory.competitions.filter(c => c.code !== 'CL' && c.code !== 'BSA')) {
      for (const id of competition.externalIds.filter(id => champions.externalIds.includes(id))) {
        const source = inventory.teams.find(team => team.externalId === id)!;
        const input = providerTeam(id, source.nomeOriginal, source.nomeCurtoPersistido);
        expect(mapTeam(input, 'CL')).toEqual(mapTeam(input, competition.code));
        shared++;
      }
    }
    expect(shared).toBe(25);
  });
  it('todos os 20 nomes BSA permanecem iguais ao inventário anterior', () => {
    for (const id of inventory.competitions.find(c => c.code === 'BSA')!.externalIds) {
      const source = inventory.teams.find(team => team.externalId === id)!;
      expect(mapTeam(providerTeam(id, source.nomeOriginal), 'BSA')).toMatchObject({
        nomeOriginal: source.nomeOriginal, nome: source.nomeCurtoPersistido, nomeCurto: source.nomeCurtoPersistido,
      });
    }
  });
  it('nenhum alias internacional cria associação Cartola ou modifica metadados do provider', () => {
    for (const id of Object.keys(NOMES_CLUBES_INTERNACIONAIS).map(Number)) {
      const input = providerTeam(id, 'Nome original', 'Curto original');
      expect(vinculoCartola('CL', id)).toEqual({});
      expect(vinculoCartola('BSA', id)).toEqual({});
      expect(mapTeam(input, 'CL')).toMatchObject({ externalId: id, nomeOriginal: input.name, sigla: input.tla, escudoUrl: input.crest, pais: input.area.name });
      expect(mapTeam(input, 'CL')).not.toHaveProperty('cartolaClubeId');
    }
  });
});
