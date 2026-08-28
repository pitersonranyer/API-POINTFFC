import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CartolaController } from '../src/cartola/cartola.controller';
import { CartolaService } from '../src/cartola/cartola.service';
import { RoundParamsDto } from '../src/cartola/dto/round-params.dto';
import { TeamIdParamsDto } from '../src/cartola/dto/team-id-params.dto';
import { TeamIdsBodyDto } from '../src/cartola/dto/team-ids-body.dto';
import { TeamSearchQueryDto } from '../src/cartola/dto/team-search-query.dto';

describe('CartolaController', () => {
  const result = { value: { ok: true }, cache: 'hit' as const, stale: false };
  const service = {
    getMarketStatus: jest.fn().mockResolvedValue(result),
    getMarketAthletes: jest.fn().mockResolvedValue(result),
    getScoredAthletes: jest.fn().mockResolvedValue(result),
    getClubs: jest.fn().mockResolvedValue(result),
    getTeamById: jest.fn().mockResolvedValue(result),
    searchTeams: jest.fn().mockResolvedValue(result),
    getTeamsByIds: jest.fn().mockResolvedValue(result),
    getMatches: jest.fn().mockResolvedValue(result),
    getMatchesByRound: jest.fn().mockResolvedValue(result),
    getDashboard: jest.fn().mockResolvedValue(result),
  };
  const response = { setHeader: jest.fn() };
  const controller = new CartolaController(service as unknown as CartolaService);

  beforeEach(() => jest.clearAllMocks());

  it('expõe os onze handlers públicos e preserva os payloads', async () => {
    const outputs = await Promise.all([
      controller.marketStatus(response as never),
      controller.marketAthletes(response as never),
      controller.scoredAthletes(response as never),
      controller.scoredAthletesByRound({ rodada: 24 }, response as never),
      controller.clubs(response as never),
      controller.searchTeams({ nome: 'Meu Time' }, response as never),
      controller.teamsByIds({ timeIds: [123, 456] }, response as never),
      controller.teamById({ timeId: 123 }, response as never),
      controller.matches(response as never),
      controller.matchesByRound({ rodada: 25 }, response as never),
      controller.dashboard(response as never),
    ]);
    expect(outputs).toEqual(Array(11).fill({ ok: true }));
    expect(service.getScoredAthletes).toHaveBeenCalledWith(24);
    expect(service.getMatchesByRound).toHaveBeenCalledWith(25);
    expect(service.searchTeams).toHaveBeenCalledWith('Meu Time');
    expect(service.getTeamsByIds).toHaveBeenCalledWith([123, 456]);
    expect(service.getTeamById).toHaveBeenCalledWith(123);
    expect(response.setHeader).toHaveBeenCalledWith('X-Cartola-Cache', 'hit');
    expect(response.setHeader).toHaveBeenCalledWith('X-Cartola-Stale', 'false');
  });

  it.each(['0', '39', '2.5', 'abc'])('rejeita rodada inválida: %s', async (round) => {
    const dto = plainToInstance(RoundParamsDto, { rodada: round });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('aceita rodada inteira de 1 a 38', async () => {
    expect(await validate(plainToInstance(RoundParamsDto, { rodada: '25' }))).toHaveLength(0);
  });

  it.each(['0', '-1', '2.5', 'abc'])('rejeita timeId inválido: %s', async (timeId) => {
    expect(await validate(plainToInstance(TeamIdParamsDto, { timeId }))).not.toHaveLength(0);
  });

  it('aplica trim e exige ao menos dois caracteres no nome', async () => {
    const valid = plainToInstance(TeamSearchQueryDto, { nome: '  Meu Time  ' });
    expect(valid.nome).toBe('Meu Time');
    expect(await validate(valid)).toHaveLength(0);
    expect(await validate(plainToInstance(TeamSearchQueryDto, { nome: ' a ' }))).not.toHaveLength(0);
  });

  it('normaliza string de IDs, remove vazios e duplicados preservando a ordem', async () => {
    const dto = plainToInstance(TeamIdsBodyDto, { timeIds: '123; 456;123;;789' });
    expect(dto.timeIds).toEqual([123, 456, 789]);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('aceita number[] e rejeita IDs inválidos ou mais de 50 IDs', async () => {
    expect(await validate(plainToInstance(TeamIdsBodyDto, { timeIds: [123, 456] }))).toHaveLength(0);
    expect(await validate(plainToInstance(TeamIdsBodyDto, { timeIds: '123;abc' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(TeamIdsBodyDto, { timeIds: Array.from({ length: 51 }, (_, index) => index + 1) }))).not.toHaveLength(0);
  });
});
