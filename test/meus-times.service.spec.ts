import { Prisma, TimeUsuario } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { MeusTimesService } from '../src/meus-times/meus-times.service';

const team = (usuarioId: string, timeId: number): TimeUsuario => ({
  usuarioId, timeId, nome: `Time ${timeId}`, nomeCartola: null, slug: null,
  urlEscudoPng: null, fotoPerfil: null, assinante: null,
  criadoEm: new Date('2026-08-27T12:00:00Z'), atualizadoEm: new Date('2026-08-27T12:00:00Z'),
});

describe('MeusTimesService', () => {
  const delegate = { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), deleteMany: jest.fn() };
  const prisma = { timeUsuario: delegate } as unknown as PrismaService;
  const service = new MeusTimesService(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('cria um vinculo e permite o mesmo time para usuarios diferentes', async () => {
    delegate.create.mockResolvedValue({});
    await expect(service.adicionarTime('usuario-a', { timeId: 10, nome: 'Time' })).resolves.toEqual({ status: 'adicionado', timeId: 10 });
    await expect(service.adicionarTime('usuario-b', { timeId: 10, nome: 'Time' })).resolves.toEqual({ status: 'adicionado', timeId: 10 });
    expect(delegate.create.mock.calls.map(([arg]) => arg.data.usuarioId)).toEqual(['usuario-a', 'usuario-b']);
  });

  it('trata a chave composta duplicada como regra de negocio', async () => {
    delegate.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }));
    await expect(service.adicionarTime('usuario-a', { timeId: 10, nome: 'Time' })).resolves.toEqual({ status: 'ja_existente', timeId: 10 });
  });

  it('lista somente pelo usuario e nao expoe usuarioId', async () => {
    delegate.findMany.mockResolvedValue([team('usuario-a', 10)]);
    const result = await service.listarTimesDoUsuario('usuario-a');
    expect(delegate.findMany).toHaveBeenCalledWith({ where: { usuarioId: 'usuario-a' }, orderBy: { criadoEm: 'desc' } });
    expect(result[0]).not.toHaveProperty('usuarioId');
  });

  it('remove usando simultaneamente usuario e time', async () => {
    delegate.deleteMany.mockResolvedValue({ count: 1 });
    await service.removerTime('usuario-a', 10);
    expect(delegate.deleteMany).toHaveBeenCalledWith({ where: { usuarioId: 'usuario-a', timeId: 10 } });
  });

  it('importa 10 itens com 7 novos e 3 existentes', async () => {
    delegate.create.mockImplementation(({ data }) => data.timeId <= 7
      ? Promise.resolve({})
      : Promise.reject(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' })));
    const times = Array.from({ length: 10 }, (_, index) => ({ timeId: index + 1, nome: `Time ${index + 1}` }));
    const result = await service.adicionarTimesEmLote('usuario-a', times);
    expect(result).toMatchObject({ solicitados: 10, adicionados: 7, jaExistentes: 3, falhas: [] });
    expect(result.timesAdicionados).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.timesJaExistentes).toEqual([8, 9, 10]);
  });

  it('continua a importacao quando um item e invalido', async () => {
    delegate.create.mockResolvedValue({});
    const result = await service.adicionarTimesEmLote('usuario-a', [
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
