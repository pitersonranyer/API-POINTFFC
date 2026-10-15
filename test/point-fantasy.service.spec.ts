import { BadGatewayException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../src/cartola/cartola.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';
import { classifyAthlete } from '../src/point-fantasy/point-fantasy.rules';

const input = { temporada: 2030, rodada: 3, versao: 1 };
const market = { temporada: 2030, rodada_atual: 3, status_mercado: 1, bola_rolando: false };
const match = { partida_id: 50, clube_casa_id: 10, clube_visitante_id: 20, timestamp: 1917388800 };
const athlete = { atleta_id: 1, clube_id: 10, posicao_id: 5, status_id: 7, apelido: 'Atleta', preco_num: 6, rodada_id: 2 };
const refs = { clubes: { '10': { nome: 'A' }, '20': { nome: 'B' }, '30': { nome: 'C' } },
  posicoes: { '5': { abreviacao: 'ata' }, '6': { abreviacao: 'tec' } } };

describe('POINT Fantasy foundation', () => {
  it.each([['0',1,10], ['5.99',1,10], ['6',2,20], ['9.99',2,20], ['10',3,30], ['100',3,30]])('classifica %s', (price, category, coins) => {
    expect(classifyAthlete(new Prisma.Decimal(price), 5)).toEqual({ categoriaId: category, pointcoins: coins });
  });
  it.each(['0','6','99'])('tecnico sempre custa 10: %s', price => {
    expect(classifyAthlete(new Prisma.Decimal(price), 6)).toEqual({ categoriaId: null, pointcoins: 10 });
  });
  it.each(['-1','NaN','Infinity','5.999','10000000000'])('rejeita preco %s', price => {
    expect(() => classifyAthlete(new Prisma.Decimal(price), 5)).toThrow(BadGatewayException);
  });

  let db: any;
  let cartola: any;
  let service: PointFantasyService;
  beforeEach(() => {
    db = {
      fantasyCatalogo: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(async ({ data }) => ({ id: 1, ...data })), update: jest.fn().mockImplementation(async ({ data }) => ({ id: 1, ...data })) },
      fantasyCatalogoAtleta: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      fantasyCompeticao: { findFirst: jest.fn(), create: jest.fn().mockImplementation(async ({ data }) => ({ id: 7, ...data })), update: jest.fn() },
    };
    db.$transaction = jest.fn(async (action: any) => typeof action === 'function' ? action(db) : Promise.all(action));
    cartola = { loadMarketStatusFresh: jest.fn().mockResolvedValue(market),
      loadMarketAthletesFresh: jest.fn().mockResolvedValue({ ...refs, atletas: [athlete] }),
      loadMatchesFresh: jest.fn().mockResolvedValue({ rodada: 3, partidas: [match] }) };
    service = new PointFantasyService(db as PrismaService, cartola as CartolaService);
  });
  it('captura atomicamente e aceita rodada anterior no atleta', async () => {
    const result = await service.capture(input);
    expect(result).toMatchObject({ id: 1, ...input });
    expect(db.fantasyCatalogo.create.mock.calls[0][0].data.atletas.create).toEqual([
      expect.objectContaining({ categoriaId: 2, pointcoins: 20, atletaIdExterno: 1 }),
    ]);
    expect(cartola.loadMarketStatusFresh).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
  it('retry de versao congelada retorna snapshot sem consultar fonte nem alterar dados', async () => {
    const frozen = { id: 1, ...input, status: 'CONGELADO' };
    db.fantasyCatalogo.findUnique.mockResolvedValue(frozen);
    expect(await service.capture(input)).toBe(frozen);
    expect(cartola.loadMarketAthletesFresh).not.toHaveBeenCalled();
    expect(db.fantasyCatalogo.create).not.toHaveBeenCalled();
    expect(db.fantasyCatalogo.update).not.toHaveBeenCalled();
  });
  it('nova versao preserva snapshot anterior', async () => {
    await service.capture({ ...input, versao: 2 });
    expect(db.fantasyCatalogo.create.mock.calls[0][0].data.versao).toBe(2);
    expect(db.fantasyCatalogo.update).not.toHaveBeenCalled();
  });
  it('versao criada por concorrente e reutilizada', async () => {
    db.fantasyCatalogo.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 2 });
    expect(await service.capture(input)).toEqual({ id: 2 });
    expect(db.fantasyCatalogo.create).not.toHaveBeenCalled();
  });
  it.each([{ temporada: 2029 }, { rodada_atual: 2 }, { status_mercado: 2 }, { bola_rolando: true }, { game_over: true }])('rejeita mercado incompativel %j', async change => {
    cartola.loadMarketStatusFresh.mockResolvedValue({ ...market, ...change });
    await expect(service.capture(input)).rejects.toThrow(ConflictException);
    expect(db.fantasyCatalogo.create).not.toHaveBeenCalled();
  });
  it('rejeita transicao de rodada durante leitura', async () => {
    cartola.loadMarketStatusFresh.mockResolvedValueOnce(market).mockResolvedValueOnce({ ...market, rodada_atual: 4 });
    await expect(service.capture(input)).rejects.toThrow(ConflictException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([[], [athlete, athlete], [{ ...athlete, preco_num: -1 }], [{ ...athlete, clube_id: 99 }]].map(atletas => ({ atletas })))('nao persiste snapshot invalido %j', async ({ atletas }) => {
    cartola.loadMarketAthletesFresh.mockResolvedValue({ ...refs, atletas });
    await expect(service.capture(input)).rejects.toThrow(BadGatewayException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejeita partidas de rodada diferente', async () => {
    cartola.loadMatchesFresh.mockResolvedValue({ rodada: 2, partidas: [match] });
    await expect(service.capture(input)).rejects.toThrow(BadGatewayException);
  });
  it('traduz corrida de unicidade para 409', async () => {
    db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('race', { code: 'P2002', clientVersion: '5.22.0' }));
    await expect(service.capture(input)).rejects.toThrow(ConflictException);
  });
  it('congelamento repetido nao modifica timestamp', async () => {
    const catalog = { id: 1, status: 'CONGELADO', congeladoEm: new Date() };
    db.fantasyCatalogo.findUnique.mockResolvedValue(catalog);
    expect(await service.freeze(1)).toBe(catalog);
    expect(db.fantasyCatalogo.update).not.toHaveBeenCalled();
  });
  it('elegibilidade filtra clubes no banco e isola competicoes', async () => {
    db.fantasyCatalogo.findUnique.mockResolvedValue({ id: 1 });
    db.fantasyCompeticao.findFirst.mockResolvedValueOnce({ catalogoId: 1, partidas: [{ clubeMandanteId: 10, clubeVisitanteId: 20 }] })
      .mockResolvedValueOnce({ catalogoId: 1, partidas: [{ clubeMandanteId: 30, clubeVisitanteId: 40 }] });
    await service.eligible(7, { page: 1, limit: 10 });
    await service.eligible(8, { page: 1, limit: 10 });
    expect(db.fantasyCatalogoAtleta.findMany.mock.calls.map((c: any) => c[0].where)).toEqual([
      { catalogoId: 1, clubeIdExterno: { in: [10, 20] } }, { catalogoId: 1, clubeIdExterno: { in: [30, 40] } },
    ]);
  });
  it('rascunhos nao aparecem na consulta publica', async () => {
    db.fantasyCompeticao.findFirst.mockResolvedValue(null);
    await expect(service.competition(7)).rejects.toThrow('nao encontrada');
    expect(db.fantasyCompeticao.findFirst.mock.calls[0][0].where).toEqual({ id: 7, status: 'PUBLICADA' });
  });
  it('rejeita selecao de partida externa ao snapshot sem congelar catalogo', async () => {
    db.fantasyCatalogo.findUnique.mockResolvedValue({ id: 1, referencias: { partidas: [] } });
    await expect(service.createCompetition({ catalogoId: 1, nome: 'Teste', tipoAcesso: 'FREE', valorInscricao: '0.00',
      inicioInscricao: '2099-01-01T12:00:00Z', fimInscricao: '2099-01-02T12:00:00Z', partidaIds: [999] })).rejects.toThrow('partidas unicas');
    expect(db.fantasyCatalogo.update).not.toHaveBeenCalled();
    expect(db.fantasyCompeticao.create).not.toHaveBeenCalled();
  });
  it('publicacao exige catalogo congelado', async () => {
    db.fantasyCompeticao.findFirst.mockResolvedValue({ id: 7, catalogoId: 1, status: 'RASCUNHO', partidas: [] });
    db.fantasyCatalogo.findUnique.mockResolvedValue({ id: 1, status: 'CAPTURADO' });
    await expect(service.publish(7)).rejects.toThrow(ConflictException);
    expect(db.fantasyCompeticao.update).not.toHaveBeenCalled();
  });
  it('publica competicao com snapshot congelado e janela valida', async () => {
    db.fantasyCompeticao.findFirst.mockResolvedValue({ id: 7, catalogoId: 1, status: 'RASCUNHO', fimInscricao: new Date('2099-01-01T12:00:00Z'),
      partidas: [{ inicioPrevisto: new Date('2099-01-02T12:00:00Z') }] });
    db.fantasyCatalogo.findUnique.mockResolvedValue({ id: 1, status: 'CONGELADO' });
    await service.publish(7);
    expect(db.fantasyCompeticao.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { status: 'PUBLICADA' }, include: { partidas: true } });
  });
  it('cria apenas partidas selecionadas e congela catalogo na mesma transacao', async () => {
    db.fantasyCatalogo.findUnique.mockResolvedValue({ id: 1, temporada: 2030, rodada: 3,
      referencias: { partidas: [
        { partidaIdExterno: 50, clubeMandanteId: 10, clubeVisitanteId: 20, inicioPrevisto: '2099-01-03T12:00:00Z' },
        { partidaIdExterno: 60, clubeMandanteId: 30, clubeVisitanteId: 40, inicioPrevisto: '2099-01-04T12:00:00Z' },
      ] } });
    await service.createCompetition({ catalogoId: 1, nome: 'Sabado', tipoAcesso: 'FREE', valorInscricao: '0.00',
      inicioInscricao: '2099-01-01T12:00:00Z', fimInscricao: '2099-01-02T12:00:00Z', partidaIds: [50] });
    expect(db.fantasyCatalogo.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CONGELADO' }) }));
    expect(db.fantasyCompeticao.create.mock.calls[0][0].data.partidas.create).toEqual([
      expect.objectContaining({ partidaIdExterno: 50, clubeMandanteId: 10, clubeVisitanteId: 20 }),
    ]);
  });
});
