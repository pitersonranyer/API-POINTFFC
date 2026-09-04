import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListarParciaisQueryDto } from '../src/parciais/dto/listar-parciais-query.dto';
import { ParciaisController } from '../src/parciais/parciais.controller';
import { ParciaisService } from '../src/parciais/parciais.service';

describe('ParciaisController', () => {
  const response = { temporada: 2026, rodada: 25, parciais: [] };
  const service = { listar: jest.fn().mockResolvedValue(response), atualizarRodadaAnterior: jest.fn() };
  const controller = new ParciaisController(service as unknown as ParciaisService);

  beforeEach(() => jest.clearAllMocks());

  it('encaminha a consulta validada ao serviço de leitura', async () => {
    const query = { temporada: 2026, rodada: 25, timeIds: [3, 1, 2] };
    await expect(controller.listar(query)).resolves.toBe(response);
    expect(service.listar).toHaveBeenCalledWith(query);
  });

  it('transforma o CSV sem remover duplicados silenciosamente', async () => {
    const valid = plainToInstance(ListarParciaisQueryDto, {
      temporada: '2026', rodada: '25', timeIds: '30157355, 12345678',
    });
    expect(valid).toMatchObject({ temporada: 2026, rodada: 25, timeIds: [30157355, 12345678] });
    expect(await validate(valid)).toHaveLength(0);

    const duplicate = plainToInstance(ListarParciaisQueryDto, {
      temporada: '2026', rodada: '25', timeIds: '30157355,30157355',
    });
    expect(await validate(duplicate)).not.toHaveLength(0);
  });

  it.each([
    { temporada: '0', rodada: '25', timeIds: '1' },
    { temporada: '2026.5', rodada: '25', timeIds: '1' },
    { temporada: '2026', rodada: '0', timeIds: '1' },
    { temporada: '2026', rodada: '39', timeIds: '1' },
    { temporada: '2026', rodada: '25', timeIds: '0' },
    { temporada: '2026', rodada: '25', timeIds: '-1' },
    { temporada: '2026', rodada: '25', timeIds: 'abc' },
    { temporada: '2026', rodada: '25', timeIds: '' },
  ])('rejeita parâmetros inválidos: %o', async (query) => {
    expect(await validate(plainToInstance(ListarParciaisQueryDto, query))).not.toHaveLength(0);
  });

  it('aceita 1000 IDs e rejeita 1001', async () => {
    const base = { temporada: '2026', rodada: '25' };
    const thousand = Array.from({ length: 1000 }, (_, index) => index + 1).join(',');
    const thousandAndOne = `${thousand},1001`;
    expect(await validate(plainToInstance(ListarParciaisQueryDto, { ...base, timeIds: thousand }))).toHaveLength(0);
    expect(await validate(plainToInstance(ListarParciaisQueryDto, { ...base, timeIds: thousandAndOne }))).not.toHaveLength(0);
  });
  it('encaminha a atualizacao da rodada anterior ao servico', async () => {
    const updated = { temporada: 2026, rodada: 24, timesCadastrados: 0, atualizados: 0, jaProcessados: 0, semSnapshot: 0, timeIdsSemSnapshot: [], falhas: 0, detalhesFalhas: [] };
    service.atualizarRodadaAnterior.mockResolvedValue(updated);

    await expect(controller.atualizarRodadaAnterior({ temporada: 2026 })).resolves.toBe(updated);
    expect(service.atualizarRodadaAnterior).toHaveBeenCalledWith(2026);
  });
});
