import { Prisma, TimeUsuario } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { MeusTimesService } from '../src/meus-times/meus-times.service';

const team = (usuarioId: number, timeId: number): TimeUsuario => ({
  usuarioId, timeId, nome: `Time ${timeId}`, nomeCartola: null, slug: null,
  urlEscudoPng: null, fotoPerfil: null, assinante: null,
  criadoEm: new Date('2026-08-27T12:00:00Z'), atualizadoEm: new Date('2026-08-27T12:00:00Z'),
});

describe('MeusTimesService', () => {
  const delegate = { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), deleteMany: jest.fn() };
  const prisma = { timeUsuario: delegate } as unknown as PrismaService;
  const service = new MeusTimesService(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('permite associar o time uma vez e bloqueia outro perfil sem revelar o usuario associado', async () => {
    delegate.create.mockResolvedValueOnce({}).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }),
    );
    delegate.findFirst.mockResolvedValue({ usuarioId: 1 });
    await expect(service.adicionarTime(1, { timeId: 10, nome: 'Time' })).resolves.toEqual({ status: 'adicionado', timeId: 10 });
    const conflict = await service.adicionarTime(2, { timeId: 10, nome: 'Time' });
    expect(conflict).toEqual({ status: 'ja_existente', timeId: 10 });
    expect(conflict).not.toHaveProperty('usuarioId');
    expect(delegate.create.mock.calls.map(([arg]) => arg.data.usuarioId)).toEqual([1, 2]);
    expect(delegate.findFirst).toHaveBeenCalledWith({ where: { timeId: 10 }, select: { usuarioId: true } });
  });

  it('trata a chave composta duplicada como regra de negocio', async () => {
    delegate.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }));
    delegate.findFirst.mockResolvedValue({ usuarioId: 1 });
    await expect(service.adicionarTime(1, { timeId: 10, nome: 'Time' })).resolves.toEqual({ status: 'ja_existente', timeId: 10 });
  });

  it('aplica as regras do DTO mesmo quando o serviço é reutilizado fora do controller', async () => {
    await expect(service.adicionarTime(1, { timeId: 0, nome: '' })).rejects.toThrow();
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it('resolve duas inclusoes concorrentes com uma unica associacao efetiva', async () => {
    let owner: number | null = null;
    delegate.create.mockImplementation(({ data }) => {
      if (owner === null) {
        owner = data.usuarioId;
        return Promise.resolve({});
      }
      return Promise.reject(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }));
    });
    delegate.findFirst.mockImplementation(() => Promise.resolve({ usuarioId: owner }));

    const results = await Promise.all([
      service.adicionarTime(1, { timeId: 10, nome: 'Time' }),
      service.adicionarTime(2, { timeId: 10, nome: 'Time' }),
    ]);

    expect(results.map(result => result.status).sort()).toEqual(['adicionado', 'ja_existente']);
    expect(owner).toBe(1);
  });

  it('lista somente pelo usuario e nao expoe usuarioId', async () => {
    delegate.findMany.mockResolvedValue([team(1, 10)]);
    const result = await service.listarTimesDoUsuario(1);
    expect(delegate.findMany).toHaveBeenCalledWith({ where: { usuarioId: 1 }, orderBy: { criadoEm: 'desc' } });
    expect(result[0]).not.toHaveProperty('usuarioId');
  });

  it('remove usando simultaneamente usuario e time', async () => {
    delegate.deleteMany.mockResolvedValue({ count: 1 });
    await service.removerTime(1, 10);
    expect(delegate.deleteMany).toHaveBeenCalledWith({ where: { usuarioId: 1, timeId: 10 } });
  });

  it('importa 10 itens com 7 novos e 3 existentes', async () => {
    delegate.create.mockImplementation(({ data }) => data.timeId <= 7
      ? Promise.resolve({})
      : Promise.reject(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' })));
    delegate.findFirst.mockResolvedValue({ usuarioId: 1 });
    const times = Array.from({ length: 10 }, (_, index) => ({ timeId: index + 1, nome: `Time ${index + 1}` }));
    const result = await service.adicionarTimesEmLote(1, times);
    expect(result).toMatchObject({ solicitados: 10, adicionados: 7, jaExistentes: 3, falhas: [] });
    expect(result.timesAdicionados).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.timesJaExistentes).toEqual([8, 9, 10]);
  });

  it('continua a importacao quando um item e invalido', async () => {
    delegate.create.mockResolvedValue({});
    const result = await service.adicionarTimesEmLote(1, [
      null,
      { timeId: -1, nome: '' },
      { timeId: 20, nome: '  Valido  ', urlEscudoPng: 'https://example.com/a.png' },
    ]);
    expect(result).toMatchObject({ solicitados: 3, adicionados: 1, jaExistentes: 0 });
    expect(result.falhas).toEqual([
      { timeId: null, motivo: 'dados_invalidos' },
      { timeId: -1, motivo: 'dados_invalidos' },
    ]);
    expect(delegate.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ timeId: 20, nome: 'Valido' }) }));
  });
});
