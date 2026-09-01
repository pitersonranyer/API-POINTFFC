import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RankingGeralQueryDto } from '../src/ranking-geral/dto/ranking-geral-query.dto';
import { RankingGeralController } from '../src/ranking-geral/ranking-geral.controller';
import { RankingGeralService } from '../src/ranking-geral/ranking-geral.service';

describe('RankingGeralController', () => {
  const response = { temporada: 2026, rodada: 25, total: 0, ranking: [] };
  const service = { consultar: jest.fn().mockResolvedValue(response) };
  const controller = new RankingGeralController(service as unknown as RankingGeralService);

  beforeEach(() => jest.clearAllMocks());

  it('é público e não possui JwtAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RankingGeralController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, RankingGeralController.prototype.consultar)).toBeUndefined();
  });

  it('encaminha a consulta ao serviço', async () => {
    const query = { temporada: 2026, rodada: 25, limit: 15 };
    await expect(controller.consultar(query)).resolves.toBe(response);
    expect(service.consultar).toHaveBeenCalledWith(query);
  });

  it('aplica limit 15 quando o parâmetro é omitido', async () => {
    const dto = plainToInstance(RankingGeralQueryDto, { temporada: '2026', rodada: '25' });
    expect(dto).toMatchObject({ temporada: 2026, rodada: 25, limit: 15 });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('aceita limit máximo 100', async () => {
    const dto = plainToInstance(RankingGeralQueryDto, { temporada: '2026', rodada: '25', limit: '100' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    { temporada: '0', rodada: '25', limit: '15' },
    { temporada: '2026.5', rodada: '25', limit: '15' },
    { temporada: '2026', rodada: '0', limit: '15' },
    { temporada: '2026', rodada: '39', limit: '15' },
    { temporada: '2026', rodada: '25', limit: '0' },
    { temporada: '2026', rodada: '25', limit: '101' },
    { temporada: '2026', rodada: '25', limit: '1.5' },
  ])('rejeita parâmetros inválidos: %o', async (query) => {
    expect(await validate(plainToInstance(RankingGeralQueryDto, query))).not.toHaveLength(0);
  });
});
