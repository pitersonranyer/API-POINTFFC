import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Desafio, DesafioPartida, Prisma } from '@prisma/client';
import { AdminDesafioPartidasService } from '../src/admin/admin-desafio-partidas.service';
import { AdminDesafiosService } from '../src/admin/admin-desafios.service';
import { FootballDataClient } from '../src/futebol/football-data.client';
import { DesafioFixture, traduzirStatusDesafio } from '../src/futebol/football-data.normalizer';
import { PrismaService } from '../src/prisma/prisma.service';
import { desafioParticipacaoFixture } from './helpers/desafio-participacao.fixture';

const oficial = (id = 123, status = 'TIMED', change: Partial<DesafioFixture> = {}): DesafioFixture => ({
  fixtureId: id, leagueId: 71, leagueNome: 'Serie A', dataHoraInicio: '2030-10-03T16:00:00.000Z',
  mandanteId: 127, mandanteNome: 'Flamengo', mandanteLogo: 'https://example.com/home.png',
  visitanteId: 121, visitanteNome: 'Palmeiras', visitanteLogo: null,
  horarioConfirmado: status === 'TIMED', statusInterno: traduzirStatusDesafio(status), ...change,
});
const partida = (id = 1, change: Partial<DesafioPartida> = {}): DesafioPartida => ({
  id, desafioId: 7, fixtureIdApiFootball: 122 + id, leagueIdApiFootball: 71, nomeCompeticao: 'Serie A',
  mandanteIdApiFootball: 127, nomeMandante: 'Flamengo', logoMandanteUrl: 'https://example.com/home.png',
  visitanteIdApiFootball: 121, nomeVisitante: 'Palmeiras', logoVisitanteUrl: null,
  dataInicio: new Date('2030-10-03T16:00:00Z'), status: 'AGENDADA', resultado: null,
  golsMandante: null, golsVisitante: null, ordem: id,
  criadoEm: new Date('2030-10-01T00:00:00Z'), atualizadoEm: new Date('2030-10-01T00:00:00Z'), ...change,
});

function setup(iniciais: DesafioPartida[] = []) {
  const state: { desafio: Desafio | null; partidas: DesafioPartida[]; dependencias: number } = {
    desafio: { id: 7, nome: 'Desafio misto', descricao: null, tipoAcesso: 'FREE', valorInscricao: new Prisma.Decimal(0),
      status: 'RASCUNHO', inicioInscricao: new Date('2030-10-01T00:00:00Z'), fimInscricao: new Date('2030-10-03T12:00:00Z'),
      dataInicio: new Date('2030-10-03T12:00:00Z'), dataFim: new Date('2030-10-04T23:00:00Z'), limiteParticipantes: null,
      limiteInscricoesPorUsuario: 1, criadoPorId: 42, publicadoEm: null, criadoEm: new Date(), atualizadoEm: new Date() },
    partidas: iniciais, dependencias: 0,
  };
  const desafio = {
    findUnique: jest.fn(async () => state.desafio && { ...state.desafio, criadoPor: { idUsuario: 42, nome: 'Admin' } }),
    update: jest.fn(async ({ data }: { data: Partial<Desafio> }) => {
      if (!state.desafio) throw new Error('missing');
      state.desafio = { ...state.desafio, ...data };
      return { ...state.desafio, criadoPor: { idUsuario: 42, nome: 'Admin' } };
    }),
  };
  const desafioPartida = {
    findMany: jest.fn(async ({ where }: { where: { desafioId: number } }) => state.partidas.filter(p => p.desafioId === where.desafioId)
      .sort((a, b) => a.ordem - b.ordem || a.id - b.id).map(p => ({ ...p }))),
    findUnique: jest.fn(async ({ where }: { where: { desafioId_fixtureIdApiFootball: { desafioId: number; fixtureIdApiFootball: number } } }) =>
      state.partidas.find(p => p.desafioId === where.desafioId_fixtureIdApiFootball.desafioId && p.fixtureIdApiFootball === where.desafioId_fixtureIdApiFootball.fixtureIdApiFootball) ?? null),
    findFirst: jest.fn(async ({ where }: { where: { id?: number; desafioId: number } }) =>
      state.partidas.filter(p => p.desafioId === where.desafioId && (where.id === undefined || p.id === where.id)).sort((a, b) => b.ordem - a.ordem)[0] ?? null),
    create: jest.fn(async ({ data }: { data: Partial<DesafioPartida> }) => {
      const novo = partida(Math.max(0, ...state.partidas.map(p => p.id)) + 1, data);
      state.partidas.push(novo); return novo;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: number }; data: Partial<DesafioPartida> }) => {
      const index = state.partidas.findIndex(p => p.id === where.id);
      if (index < 0) throw new Error('missing');
      state.partidas[index] = { ...state.partidas[index], ...data }; return state.partidas[index];
    }),
    delete: jest.fn(async ({ where }: { where: { id: number } }) => {
      state.partidas = state.partidas.filter(p => p.id !== where.id);
    }),
  };
  const tx = { desafio, desafioPartida, desafioPalpite: { count: jest.fn(async () => state.dependencias) },
    $queryRaw: jest.fn(async () => state.desafio ? [{ ID: 7n }] : []) };
  let queue = Promise.resolve();
  const prisma = { ...tx, $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
    const previous = queue; let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const backup = { desafio: state.desafio && { ...state.desafio }, partidas: state.partidas.map(p => ({ ...p })) };
    try { return await fn(tx); } catch (error) { Object.assign(state, backup); throw error; } finally { release(); }
  }) };
  const api = { pesquisarPartidasPorPeriodo: jest.fn(async () => [oficial()]), buscarPartidasPorIds: jest.fn(async (ids: number[]) => ids.map(id => oficial(id))) };
  const service = new AdminDesafioPartidasService(prisma as unknown as PrismaService, api as unknown as FootballDataClient);
  const admin = new AdminDesafiosService(prisma as unknown as PrismaService, service);
  return { state, tx, prisma, api, service, admin };
}

describe('Administracao de partidas do Desafio', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2030-10-01T12:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('recalcula primeira/ultima ao adicionar e remover, sem depender da ordem de exibicao', async () => {
    const f = setup();
    f.api.buscarPartidasPorIds.mockResolvedValueOnce([oficial(123, 'TIMED', { dataHoraInicio: '2030-10-09T20:00:00Z' })]);
    await f.service.adicionar(7, 123);
    expect(f.state.desafio).toMatchObject({ dataInicio: new Date('2030-10-09T20:00:00Z'),
      fimInscricao: new Date('2030-10-09T20:00:00Z'), dataFim: new Date('2030-10-09T23:00:00Z') });
    await f.service.adicionar(7, 124);
    expect(f.state.desafio!.dataInicio).toEqual(new Date('2030-10-03T16:00:00Z'));
    await f.service.reordenar(7, [1, 2]);
    expect(f.state.desafio!.dataInicio).toEqual(new Date('2030-10-03T16:00:00Z'));
    await f.service.remover(7, 2);
    expect(f.state.desafio!.dataInicio).toEqual(new Date('2030-10-09T20:00:00Z'));
    await f.service.adicionar(7, 124);
    await f.service.remover(7, 1);
    expect(f.state.desafio!.dataFim).toEqual(new Date('2030-10-03T19:00:00Z'));
    await f.service.remover(7, 2);
    expect(f.state.partidas).toHaveLength(0);
    expect(f.state.desafio!.status).toBe('RASCUNHO');
    await expect(f.admin.publicar(7)).rejects.toThrow('pelo menos uma partida');
  });

  it.each(['FREE', 'PAGO'] as const)('publicacao abre participacao %s imediatamente e primeiro kickoff fecha sem cron', async tipoAcesso => {
    const f = setup([partida(1), partida(2)]);
    Object.assign(f.state.desafio!, { tipoAcesso, valorInscricao: new Prisma.Decimal(tipoAcesso === 'FREE' ? 0 : 2) });
    await f.admin.publicar(7);
    expect(f.state.desafio!.inicioInscricao).toEqual(new Date());
    expect(f.state.desafio!.fimInscricao).toEqual(f.state.desafio!.dataInicio);
    const participacao = desafioParticipacaoFixture();
    Object.assign(participacao.desafio, f.state.desafio);
    participacao.state.partidas = f.state.partidas;
    await expect(participacao.service.participar(7, 42)).resolves.toMatchObject({ tipoAcesso, valorCobrado: tipoAcesso === 'FREE' ? '0.00' : '2.00' });
    expect(participacao.state.movimentos).toHaveLength(tipoAcesso === 'FREE' ? 0 : 1);
    jest.setSystemTime(f.state.desafio!.dataInicio);
    await expect(participacao.service.participar(7, 43)).rejects.toBeInstanceOf(ConflictException);
    expect(participacao.state.inscricoes.filter(i => i.status === 'ATIVA')).toHaveLength(1);
    expect(participacao.state.movimentos).toHaveLength(tipoAcesso === 'FREE' ? 0 : 1);
    await expect(f.admin.buscar(7)).resolves.toMatchObject({ status: 'EM_ANDAMENTO' });
    await expect(f.admin.cancelar(7)).rejects.toBeInstanceOf(ConflictException);
  });

  it('busca somente por periodo sem gravar', async () => {
    const f = setup();
    await f.service.pesquisar({ dataInicial: '2030-10-01', dataFinal: '2030-10-07' });
    expect(f.api.pesquisarPartidasPorPeriodo).toHaveBeenCalledWith('2030-10-01', '2030-10-07');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.tx.desafioPartida.create).not.toHaveBeenCalled();
  });

  it('propaga falha externa da busca sem transforma-la em 404', async () => {
    const f = setup(); f.api.pesquisarPartidasPorPeriodo.mockRejectedValue(new ServiceUnavailableException());
    await expect(f.service.pesquisar({ dataInicial: '2030-10-03', dataFinal: '2030-10-03' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('adiciona snapshot oficial com proxima ordem, sem resultado ou gols', async () => {
    const f = setup([partida(1, { ordem: 4 })]);
    const result = await f.service.adicionar(7, 124);
    expect(result).toMatchObject({ fixtureIdApiFootball: 124, nomeMandante: 'Flamengo', nomeVisitante: 'Palmeiras', nomeCompeticao: 'Serie A',
      ordem: 5, status: 'AGENDADA', resultado: null, golsMandante: null, golsVisitante: null });
    expect(f.api.buscarPartidasPorIds).toHaveBeenCalledTimes(1);
    expect(f.api.buscarPartidasPorIds.mock.invocationCallOrder[0]).toBeLessThan(f.tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(f.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(f.tx.desafioPartida.create.mock.invocationCallOrder[0]);
  });

  it.each(['IN_PLAY', 'HT', '2H', 'ET', 'FINISHED', 'AET', 'PEN', 'CANC', 'SUSP', 'POSTPONED', 'SCHEDULED', 'OUTRO'])('nao adiciona status %s', async status => {
    const f = setup(); f.api.buscarPartidasPorIds.mockResolvedValue([oficial(123, status)]);
    await expect(f.service.adicionar(7, 123)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.state.partidas).toEqual([]);
  });

  it('rejeita TIMED com horario passado ou exatamente agora', async () => {
    const f = setup(); f.api.buscarPartidasPorIds.mockResolvedValue([oficial(123, 'TIMED', { dataHoraInicio: new Date().toISOString() })]);
    await expect(f.service.adicionar(7, 123)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('distingue fixture inexistente, falha externa e Desafio inexistente', async () => {
    const f = setup(); f.api.buscarPartidasPorIds.mockResolvedValueOnce([]);
    await expect(f.service.adicionar(7, 123)).rejects.toThrow('Fixture 123 nao encontrada na football-data.org.');
    f.api.buscarPartidasPorIds.mockRejectedValueOnce(new ServiceUnavailableException());
    await expect(f.service.adicionar(7, 123)).rejects.toBeInstanceOf(ServiceUnavailableException);
    f.state.desafio = null;
    await expect(f.service.adicionar(999, 123)).rejects.toThrow('Desafio nao encontrado.');
    await expect(f.service.listar(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejeita duplicidade amigavelmente e permite fixture de outro Desafio', async () => {
    const f = setup([partida()]);
    await expect(f.service.adicionar(7, 123)).rejects.toBeInstanceOf(ConflictException);
    expect(f.api.buscarPartidasPorIds).not.toHaveBeenCalled();
    f.state.partidas[0].desafioId = 8;
    await expect(f.service.adicionar(7, 123)).resolves.toMatchObject({ desafioId: 7, fixtureIdApiFootball: 123, ordem: 1 });
  });

  it('traduz conflito de unique do banco', async () => {
    const f = setup(); f.tx.desafioPartida.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }));
    await expect(f.service.adicionar(7, 123)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['ABERTO', 'EM_ANDAMENTO', 'ENCERRADO', 'CANCELADO'] as const)('congela composicao em %s', async status => {
    const f = setup([partida()]); f.state.desafio!.status = status;
    await expect(f.service.adicionar(7, 124)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.remover(7, 1)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.reordenar(7, [1])).rejects.toBeInstanceOf(ConflictException);
    expect(f.api.buscarPartidasPorIds).not.toHaveBeenCalled();
  });

  it('lista ordenada e serializa datas', async () => {
    const f = setup([partida(2, { ordem: 1 }), partida(1, { ordem: 3 })]);
    const result = await f.service.listar(7);
    expect(result.map(p => p.id)).toEqual([2, 1]);
    expect(result[0].dataInicio).toBe('2030-10-03T16:00:00.000Z');
    expect(f.tx.desafioPartida.findMany).toHaveBeenCalledWith({ where: { desafioId: 7 }, orderBy: [{ ordem: 'asc' }, { id: 'asc' }] });
  });

  it('remove e normaliza apenas partidas restantes deste Desafio', async () => {
    const f = setup([partida(1), partida(2), partida(3), partida(4, { desafioId: 8 })]);
    const result = await f.service.remover(7, 2);
    expect(result.map(p => [p.id, p.ordem])).toEqual([[1, 1], [3, 2]]);
    expect(f.state.partidas.find(p => p.id === 4)?.ordem).toBe(4);
    await expect(f.service.remover(7, 4)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('preserva partida com palpites existentes e traduz FK restritiva', async () => {
    const f = setup([partida()]); f.state.dependencias = 1;
    await expect(f.service.remover(7, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.desafioPartida.delete).not.toHaveBeenCalled();
    f.state.dependencias = 0;
    f.tx.desafioPartida.delete.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('FK', { code: 'P2003', clientVersion: 'test' }));
    await expect(f.service.remover(7, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(f.state.partidas).toHaveLength(1);
  });

  it('normaliza reordenacao e desfaz remocao se renumeracao falhar', async () => {
    const f = setup([partida(1), partida(2), partida(3)]);
    expect((await f.service.reordenar(7, [3, 1, 2])).map(p => [p.id, p.ordem])).toEqual([[3, 1], [1, 2], [2, 3]]);
    f.tx.desafioPartida.update.mockRejectedValueOnce(new Error('falha'));
    await expect(f.service.remover(7, 1)).rejects.toThrow('falha');
    expect(f.state.partidas).toHaveLength(3);
  });

  it.each([{ ids: [1, 1] }, { ids: [1] }, { ids: [1, 999] }, { ids: [] }])('rejeita ordem duplicada/incompleta/externa: %j', async ({ ids }) => {
    const f = setup([partida(1), partida(2)]);
    await expect(f.service.reordenar(7, ids)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.tx.desafioPartida.update).not.toHaveBeenCalled();
  });

  it('adicoes concorrentes recebem ordens distintas e duplicatas sao rejeitadas sob lock', async () => {
    const f = setup();
    await Promise.all([f.service.adicionar(7, 123), f.service.adicionar(7, 124)]);
    expect(f.state.partidas.map(p => p.ordem)).toEqual([1, 2]);
    const g = setup();
    const results = await Promise.allSettled([g.service.adicionar(7, 123), g.service.adicionar(7, 123)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(g.state.partidas).toHaveLength(1);
    expect(g.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
  });

  it('adicao em voo nao grava se Desafio for publicado durante consulta externa', async () => {
    const f = setup(); f.api.buscarPartidasPorIds.mockImplementationOnce(async () => { f.state.desafio!.status = 'ABERTO'; return [oficial()]; });
    await expect(f.service.adicionar(7, 123)).rejects.toBeInstanceOf(ConflictException);
    expect(f.state.partidas).toEqual([]);
  });

  it('nao publica sem partidas nem chama API', async () => {
    const f = setup();
    await expect(f.admin.publicar(7)).rejects.toThrow('pelo menos uma partida');
    expect(f.api.buscarPartidasPorIds).not.toHaveBeenCalled();
    expect(f.state.desafio!.status).toBe('RASCUNHO');
  });

  it('publica competicoes mistas, reconsulta uma vez e atualiza horario oficial antes de publicar', async () => {
    const f = setup([partida(1), partida(2, { leagueIdApiFootball: 39 })]);
    f.api.buscarPartidasPorIds.mockResolvedValue([oficial(123, 'TIMED', { dataHoraInicio: '2030-10-03T18:00:00Z', mandanteNome: 'Nome oficial' }),
      oficial(124, 'TIMED', { leagueId: 39, leagueNome: 'Premier League' })]);
    const result = await f.admin.publicar(7);
    expect(result.status).toBe('ABERTO');
    expect(result.publicadoEm).toBe(new Date().toISOString());
    expect(f.api.buscarPartidasPorIds).toHaveBeenCalledTimes(1);
    expect(f.api.buscarPartidasPorIds).toHaveBeenCalledWith([123, 124]);
    expect(f.state.partidas[0]).toMatchObject({ nomeMandante: 'Nome oficial', dataInicio: new Date('2030-10-03T18:00:00Z') });
    expect(f.state.partidas[1].nomeCompeticao).toBe('Premier League');
    expect(f.api.buscarPartidasPorIds.mock.invocationCallOrder[0]).toBeLessThan(f.tx.$queryRaw.mock.invocationCallOrder[0]);
  });

  it.each(['IN_PLAY', 'FINISHED', 'CANC', 'SUSP', 'POSTPONED', 'SCHEDULED'])('nao publica fixture agora em %s', async status => {
    const f = setup([partida()]); f.api.buscarPartidasPorIds.mockResolvedValue([oficial(123, status)]);
    await expect(f.admin.publicar(7)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.state.desafio!.status).toBe('RASCUNHO');
    expect(f.tx.desafioPartida.update).not.toHaveBeenCalled();
  });

  it.each(['2030-10-01T12:00:00Z', '2030-09-30T11:59:59Z'])('nao publica horario oficial iniciado: %s', async dataHoraInicio => {
    const f = setup([partida()]); f.api.buscarPartidasPorIds.mockResolvedValue([oficial(123, 'TIMED', { dataHoraInicio })]);
    await expect(f.admin.publicar(7)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.state.desafio!.publicadoEm).toBeNull();
    expect(f.state.partidas[0].dataInicio).toEqual(new Date('2030-10-03T16:00:00Z'));
  });

  it.each(['2030-10-03T11:59:59Z', '2030-10-04T23:00:01Z'])('aceita horario fora do antigo periodo: %s', async dataHoraInicio => {
    const f = setup([partida()]); f.api.buscarPartidasPorIds.mockResolvedValue([oficial(123, 'TIMED', { dataHoraInicio })]);
    await expect(f.admin.publicar(7)).resolves.toMatchObject({ status: 'ABERTO' });
  });

  it('recalcula periodo antigo e rejeita snapshot interno nao agendado', async () => {
    const f = setup([partida()]); f.state.desafio!.dataFim = new Date('2030-10-03T15:00:00Z');
    await expect(f.admin.publicar(7)).resolves.toMatchObject({ dataInicio: '2030-10-03T16:00:00.000Z', dataFim: '2030-10-03T19:00:00.000Z' });
    const g = setup([partida(1, { status: 'ANULADA' })]);
    await expect(g.admin.publicar(7)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejeita fixture desaparecida, identidade divergente e falha externa sem publicar', async () => {
    const f = setup([partida()]); f.api.buscarPartidasPorIds.mockResolvedValueOnce([]);
    await expect(f.admin.publicar(7)).rejects.toThrow('Fixture 123 nao encontrada');
    f.api.buscarPartidasPorIds.mockResolvedValueOnce([oficial(123, 'TIMED', { mandanteId: 999 })]);
    await expect(f.admin.publicar(7)).rejects.toBeInstanceOf(ConflictException);
    f.api.buscarPartidasPorIds.mockRejectedValueOnce(new ServiceUnavailableException());
    await expect(f.admin.publicar(7)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.state.desafio!.status).toBe('RASCUNHO');
  });

  it('rejeita mudanca de composicao enquanto API e consultada', async () => {
    const f = setup([partida()]);
    f.api.buscarPartidasPorIds.mockImplementationOnce(async () => { f.state.partidas.push(partida(2)); return [oficial()]; });
    await expect(f.admin.publicar(7)).rejects.toThrow('Composicao das partidas mudou');
    expect(f.state.desafio!.status).toBe('RASCUNHO');
  });

  it('nao publica duas vezes concorrentemente e nao aceita cancelamento durante a consulta', async () => {
    const f = setup([partida()]);
    const result = await Promise.allSettled([f.admin.publicar(7), f.admin.publicar(7)]);
    expect(result.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const g = setup([partida()]);
    g.api.buscarPartidasPorIds.mockImplementationOnce(async () => { g.state.desafio!.status = 'CANCELADO'; return [oficial()]; });
    await expect(g.admin.publicar(7)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rollback dos snapshots se publicar falhar', async () => {
    const f = setup([partida()]); f.api.buscarPartidasPorIds.mockResolvedValue([oficial(123, 'TIMED', { dataHoraInicio: '2030-10-03T18:00:00Z' })]);
    f.tx.desafio.update.mockRejectedValueOnce(new Error('falha de escrita'));
    await expect(f.admin.publicar(7)).rejects.toThrow('falha de escrita');
    expect(f.state.partidas[0].dataInicio).toEqual(new Date('2030-10-03T16:00:00Z'));
    expect(f.state.desafio!.status).toBe('RASCUNHO');
  });

  it('rollback se a escrita da publicacao atravessar o primeiro kickoff', async () => {
    const f = setup([partida()]);
    f.tx.desafio.update.mockImplementationOnce(async ({ data }) => {
      f.state.desafio = { ...f.state.desafio!, ...data };
      jest.setSystemTime(f.state.desafio.dataInicio);
      return { ...f.state.desafio, criadoPor: { idUsuario: 42, nome: 'Admin' } };
    });
    await expect(f.admin.publicar(7)).rejects.toThrow('Primeira partida ja iniciou');
    expect(f.state.desafio!.status).toBe('RASCUNHO');
    expect(f.state.desafio!.publicadoEm).toBeNull();
  });
});
