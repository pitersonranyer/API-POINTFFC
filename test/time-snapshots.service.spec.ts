import { BadGatewayException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../src/cartola/cartola.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TimeSnapshotsService } from '../src/time-snapshots/time-snapshots.service';

describe('TimeSnapshotsService', () => {
  const payload = {
    time: {
      time_id: 123,
      nome: 'Time Original',
      nome_cartola: 'Cartoleiro',
      slug: 'time-original',
      url_escudo_png: 'https://example.com/escudo.png',
      foto_perfil: 'https://example.com/perfil.png',
      assinante: true,
    },
    esquema_id: 343,
    patrimonio: 125.47,
    capitao_id: 10,
    reserva_luxo_id: 20,
    atletas: [
      { atleta_id: 10, posicao_id: 5, clube_id: 1 },
      { atleta_id: 11, posicao_id: 4, clube_id: 2 },
    ],
    reservas: [{ atleta_id: 20, posicao_id: 5, clube_id: 3 }],
  };

  const cartola = { getTeamById: jest.fn() };
  const tx = {
    timeCartola: { upsert: jest.fn() },
    timeRodada: { findUnique: jest.fn(), create: jest.fn() },
    escalacaoTimeRodada: { createMany: jest.fn() },
  };
  const prisma = { $transaction: jest.fn(), timeRodada: { findUnique: jest.fn() } };
  const service = new TimeSnapshotsService(
    cartola as unknown as CartolaService,
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    cartola.getTeamById.mockResolvedValue({ value: payload, cache: 'miss', stale: false });
    tx.timeCartola.upsert.mockResolvedValue({});
    tx.timeRodada.findUnique.mockResolvedValue(null);
    tx.timeRodada.create.mockResolvedValue({ id: 1 });
    tx.escalacaoTimeRodada.createMany.mockResolvedValue({ count: 3 });
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    prisma.timeRodada.findUnique.mockResolvedValue(null);
  });

  it('cria o TIME_CARTOLA global com o ID oficial e seus metadados', async () => {
    await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });

    expect(tx.timeCartola.upsert).toHaveBeenCalledWith({
      where: { timeId: 123 },
      create: {
        timeId: 123,
        nomeTime: 'Time Original',
        nomeCartoleiro: 'Cartoleiro',
        slug: 'time-original',
        escudoUrl: 'https://example.com/escudo.png',
        fotoPerfilUrl: 'https://example.com/perfil.png',
        assinante: true,
      },
      update: expect.objectContaining({ nomeTime: 'Time Original', nomeCartoleiro: 'Cartoleiro' }),
    });
  });

  it('solicita payload fresh ao Cartola para não criar snapshot a partir do cache', async () => {
    await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });

    expect(cartola.getTeamById).toHaveBeenCalledWith(123, { forceRefresh: true, round: 25 });
  });

  it('atualiza os metadados de um TIME_CARTOLA existente por upsert', async () => {
    cartola.getTeamById.mockResolvedValue({
      value: { ...payload, time: { ...payload.time, nome: 'Nome Atualizado', slug: 'nome-atualizado' } },
      cache: 'miss',
      stale: false,
    });

    await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });

    expect(tx.timeCartola.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ nomeTime: 'Nome Atualizado', slug: 'nome-atualizado' }),
    }));
  });

  it('cria TIME_RODADA sem qualquer campo de pontuação', async () => {
    await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });

    expect(tx.timeRodada.create).toHaveBeenCalledWith({ data: {
      timeId: 123,
      temporada: 2026,
      rodada: 25,
      esquemaTatico: 343,
      patrimonio: expect.objectContaining({}),
      capitaoId: 10,
      reservaLuxoId: 20,
      status: 'CAPTURADO',
    } });
    expect(tx.timeRodada.create.mock.calls[0][0].data).not.toHaveProperty('pontuacao');
  });

  it('persiste reserva_luxo_id somente na criação do snapshot original', async () => {
    await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });
    expect(tx.timeRodada.create.mock.calls[0][0].data.reservaLuxoId).toBe(20);

    tx.timeRodada.findUnique.mockResolvedValue({
      id: 2,
      reservaLuxoId: null,
      escalacao: [{ atletaId: 10, titular: true, reserva: false }],
    });
    await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });
    expect(tx.timeRodada.create).toHaveBeenCalledTimes(1);
  });

  it('aceita snapshot novo sem Reserva de Luxo e persiste null', async () => {
    const { reserva_luxo_id: _ignored, ...withoutLuxuryReserve } = payload;
    void _ignored;
    cartola.getTeamById.mockResolvedValue({ value: withoutLuxuryReserve, cache: 'miss', stale: false });

    await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });

    expect(tx.timeRodada.create.mock.calls[0][0].data.reservaLuxoId).toBeNull();
  });

  it('persiste titulares, reservas e identifica o capitão sem aplicar multiplicador', async () => {
    const result = await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });

    expect(result).toMatchObject({ criado: true, titulares: 2, reservas: 1 });
    const rows = tx.escalacaoTimeRodada.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      { timeRodadaId: 1, atletaId: 10, posicaoId: 5, clubeId: 1, titular: true, reserva: false, capitao: true },
      { timeRodadaId: 1, atletaId: 11, posicaoId: 4, clubeId: 2, titular: true, reserva: false, capitao: false },
      { timeRodadaId: 1, atletaId: 20, posicaoId: 5, clubeId: 3, titular: false, reserva: true, capitao: false },
    ]);
    expect(rows.every((row: Record<string, unknown>) => !('multiplicador' in row))).toBe(true);
  });

  it('é idempotente e não sobrescreve a escalação original existente', async () => {
    tx.timeRodada.findUnique.mockResolvedValue({
      id: 2,
      escalacao: [
        { atletaId: 10, titular: true, reserva: false },
        { atletaId: 20, titular: false, reserva: true },
      ],
    });

    const result = await service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 });

    expect(result).toMatchObject({ timeRodadaId: 2, criado: false, titulares: 1, reservas: 1 });
    expect(tx.timeRodada.create).not.toHaveBeenCalled();
    expect(tx.escalacaoTimeRodada.createMany).not.toHaveBeenCalled();
    expect(tx.timeCartola.upsert).toHaveBeenCalledTimes(1);
  });

  it('recupera o snapshot vencedor quando duas capturas disputam a mesma chave', async () => {
    const conflito = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: 'TIME_RODADA_TIME_ID_TEMPORADA_RODADA_key' },
    });
    const snapshotVencedor = {
      id: 1,
      escalacao: [
        { titular: true, reserva: false },
        { titular: false, reserva: true },
      ],
    };
    let chamada = 0;
    prisma.$transaction.mockImplementation(async (callback) => {
      chamada += 1;
      if (chamada === 2) throw conflito;
      return callback(tx);
    });
    prisma.timeRodada.findUnique.mockResolvedValue(snapshotVencedor);

    const [primeira, segunda] = await Promise.all([
      service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 }),
      service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 }),
    ]);

    expect(primeira).toMatchObject({ timeRodadaId: 1, criado: true });
    expect(segunda).toMatchObject({ timeRodadaId: 1, criado: false, titulares: 1, reservas: 1 });
    expect(primeira.timeRodadaId).toBe(segunda.timeRodadaId);
    expect(prisma.timeRodada.findUnique).toHaveBeenCalledWith({
      where: { timeId_temporada_rodada: { timeId: 123, temporada: 2026, rodada: 25 } },
      include: { escalacao: true },
    });
  });

  it('recupera o snapshot quando a disputa acontece primeiro na chave primária de TIME_CARTOLA', async () => {
    prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { modelName: 'TimeCartola', target: 'PRIMARY' },
    }));
    prisma.timeRodada.findUnique.mockResolvedValue({
      id: 3,
      escalacao: [{ titular: true, reserva: false }],
    });

    await expect(service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 }))
      .resolves.toMatchObject({ timeRodadaId: 3, criado: false });
  });

  it('não mascara P2002 de outra constraint como concorrência de TIME_RODADA', async () => {
    prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: 'ESCALACAO_TIME_RODADA_TIME_RODADA_ID_ATLETA_ID_key' },
    }));

    await expect(service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(prisma.timeRodada.findUnique).not.toHaveBeenCalled();
  });

  it('mantém todas as escritas na mesma transação e propaga erro de persistência', async () => {
    tx.escalacaoTimeRodada.createMany.mockRejectedValue(new Error('falha ao persistir escalação'));

    await expect(service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 }))
      .rejects.toThrow('falha ao persistir escalação');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.timeCartola.upsert).toHaveBeenCalledTimes(1);
    expect(tx.timeRodada.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { description: 'sem nome do time', value: { ...payload, time: { time_id: 123 } } },
    { description: 'sem titulares', value: { ...payload, atletas: undefined } },
    { description: 'atleta incompleto', value: { ...payload, atletas: [{ atleta_id: 10 }] } },
    { description: 'time divergente', value: { ...payload, time: { ...payload.time, time_id: 999 } } },
    { description: 'capitão fora da escalação', value: { ...payload, capitao_id: 999 } },
    { description: 'atleta duplicado', value: { ...payload, reservas: [{ atleta_id: 10, posicao_id: 5 }] } },
    { description: 'Reserva de Luxo fora das reservas', value: { ...payload, reserva_luxo_id: 999 } },
  ])('rejeita payload Cartola inesperado: $description', async ({ value }) => {
    cartola.getTeamById.mockResolvedValue({ value, cache: 'miss', stale: false });

    await expect(service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 }))
      .rejects.toBeInstanceOf(BadGatewayException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejeita payload sem titulares para permitir uma nova tentativa posterior', async () => {
    cartola.getTeamById.mockResolvedValue({
      value: { time: { time_id: 123, nome: 'Time mínimo' }, atletas: [] },
      cache: 'miss',
      stale: false,
    });

    await expect(service.criarSnapshot({ timeId: 123, temporada: 2026, rodada: 25 }))
      .rejects.toBeInstanceOf(BadGatewayException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.escalacaoTimeRodada.createMany).not.toHaveBeenCalled();
  });
});
