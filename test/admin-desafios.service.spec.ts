import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DesafioStatus, DesafioTipoAcesso, Prisma } from '@prisma/client';
import { AdminDesafiosService } from '../src/admin/admin-desafios.service';
import { AdminDesafioPartidasService } from '../src/admin/admin-desafio-partidas.service';
import { CriarAdminDesafioDto } from '../src/admin/dto/admin-desafios.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const dto = (change: Partial<CriarAdminDesafioDto> = {}): CriarAdminDesafioDto => ({
  nome: 'Desafio outubro', tipoAcesso: DesafioTipoAcesso.FREE, valorInscricao: '0.00',
  inicioInscricao: '2026-10-01T00:00:00Z', fimInscricao: '2026-10-02T00:00:00Z',
  dataInicio: '2026-10-02T00:00:00Z', dataFim: '2026-10-03T00:00:00Z', ...change,
});

const row = (change: Record<string, unknown> = {}) => ({
  ...dto(), id: 7, descricao: null, limiteParticipantes: null, limiteInscricoesPorUsuario: 1, criadoPorId: 42,
  criadoPor: { idUsuario: 42, nome: 'Admin' }, status: DesafioStatus.RASCUNHO,
  valorInscricao: new Prisma.Decimal('0.00'), publicadoEm: null,
  inicioInscricao: new Date(dto().inicioInscricao!), fimInscricao: new Date(dto().fimInscricao!),
  dataInicio: new Date(dto().dataInicio!), dataFim: new Date(dto().dataFim!),
  criadoEm: new Date('2026-09-28T00:00:00Z'), atualizadoEm: new Date('2026-09-28T00:00:00Z'), ...change,
});

describe('AdminDesafiosService', () => {
  const desafio = { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() };
  const tx = { desafio, $queryRaw: jest.fn() };
  const prisma = { desafio, $transaction: jest.fn(async (input: Array<Promise<unknown>> | ((client: typeof tx) => Promise<unknown>)) =>
    typeof input === 'function' ? input(tx) : Promise.all(input)) };
  const partidas = { prepararPublicacao: jest.fn(), aplicarPublicacao: jest.fn(), recalcularPeriodo: jest.fn() };
  const service = new AdminDesafiosService(prisma as unknown as PrismaService, partidas as unknown as AdminDesafioPartidasService);

  beforeEach(() => {
    jest.clearAllMocks();
    partidas.prepararPublicacao.mockResolvedValue({ partidas: [], fixtures: new Map() });
    const periodo = { inicioInscricao: new Date(), fimInscricao: new Date('2099-10-03T16:00:00Z'),
      dataInicio: new Date('2099-10-03T16:00:00Z'), dataFim: new Date('2099-10-03T19:00:00Z') };
    partidas.aplicarPublicacao.mockResolvedValue(periodo);
    partidas.recalcularPeriodo.mockResolvedValue(periodo);
    tx.$queryRaw.mockResolvedValue([{ ID: 7n }]);
    desafio.findUnique.mockResolvedValue(row());
    desafio.create.mockImplementation(async ({ data }) => row(data));
    desafio.update.mockImplementation(async ({ data }) => row(data));
    desafio.count.mockResolvedValue(1);
    desafio.findMany.mockResolvedValue([row()]);
  });

  it.each([
    [DesafioTipoAcesso.FREE, '0.00'], [DesafioTipoAcesso.PAGO, '2.00'],
    [DesafioTipoAcesso.PAGO, '9999999999.99'], [DesafioTipoAcesso.PAGO, '0.01'],
  ])('cria %s com valor %s sem perder precisao e sem publicar', async (tipoAcesso, valorInscricao) => {
    const result = await service.criar(42, dto({ tipoAcesso, valorInscricao }));
    expect(result).toMatchObject({ tipoAcesso, valorInscricao, criadoPorId: 42, status: 'RASCUNHO', publicadoEm: null,
      inicioInscricao: '2026-10-01T00:00:00.000Z', criadoPor: { idUsuario: 42, nome: 'Admin' } });
    expect(desafio.create.mock.calls[0][0].data.valorInscricao).toEqual(new Prisma.Decimal(valorInscricao));
    expect(desafio.create.mock.calls[0][0].select.criadoPor).toEqual({ select: { idUsuario: true, nome: true } });
  });

  const invalidos: Array<[string, Partial<CriarAdminDesafioDto>]> = [
    ['FREE com valor', { valorInscricao: '2.00' }],
    ['PAGO zero', { tipoAcesso: DesafioTipoAcesso.PAGO, valorInscricao: '0' }],
    ['PAGO negativo', { tipoAcesso: DesafioTipoAcesso.PAGO, valorInscricao: '-1' }],
    ['precisao excedida', { valorInscricao: '0.001' }],
    ['valor excedido', { valorInscricao: '10000000000.00' }],
    ['inscricoes iguais', { inicioInscricao: dto().fimInscricao }],
    ['inscricoes invertidas', { inicioInscricao: '2026-10-04T00:00:00Z' }],
    ['inscricao apos inicio', { fimInscricao: '2026-10-02T00:00:01Z' }],
    ['desafio sem duracao', { dataFim: dto().dataInicio }],
    ['desafio invertido', { dataFim: '2026-09-30T00:00:00Z' }],
    ['data invalida', { dataInicio: 'invalida' }],
    ['limite zero', { limiteParticipantes: 0 }],
    ['limite negativo', { limiteParticipantes: -1 }],
    ['limite fracionario', { limiteParticipantes: 1.5 }],
    ['limite excedido', { limiteParticipantes: 4294967296 }],
    ['nome vazio', { nome: '  ' }],
  ];

  it.each(['FREE', 'PAGO'] as const)('cria rascunho %s sem datas operacionais', async tipoAcesso => {
    const result = await service.criar(42, { nome: 'Sem datas', tipoAcesso, valorInscricao: tipoAcesso === 'FREE' ? '0' : '2' });
    expect(result.status).toBe('RASCUNHO');
    expect(result.publicadoEm).toBeNull();
    expect(new Date(result.dataInicio as string).getTime()).toBeGreaterThan(new Date(result.inicioInscricao as string).getTime());
  });

  it.each(invalidos)('rejeita criacao: %s', async (_label, change) => {
    await expect(service.criar(42, dto(change))).rejects.toBeInstanceOf(BadRequestException);
    expect(desafio.create).not.toHaveBeenCalled();
  });

  it('edita rascunho, permite limpar opcionais e preserva valores nao enviados', async () => {
    await expect(service.atualizar(7, { nome: 'Novo', descricao: null, limiteParticipantes: null }))
      .resolves.toMatchObject({ nome: 'Novo', descricao: null, limiteParticipantes: null, status: 'RASCUNHO' });
    expect(desafio.update.mock.calls[0][0].data).toEqual({ nome: 'Novo', descricao: null, limiteParticipantes: null });
  });

  it('valida combinacao FREE/PAGO do estado final no PATCH sem corrigir valor', async () => {
    desafio.findUnique.mockResolvedValue(row({ tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal('2') }));
    await expect(service.atualizar(7, { tipoAcesso: DesafioTipoAcesso.FREE })).rejects.toBeInstanceOf(BadRequestException);
    expect(desafio.update).not.toHaveBeenCalled();
    await expect(service.atualizar(7, { tipoAcesso: DesafioTipoAcesso.FREE, valorInscricao: '0.00' }))
      .resolves.toMatchObject({ tipoAcesso: 'FREE', valorInscricao: '0.00' });
  });

  it('datas enviadas no PATCH cedem ao periodo das partidas; limite continua validado', async () => {
    await expect(service.atualizar(7, { dataInicio: '2026-10-01T12:00:00Z' })).resolves.toMatchObject({ dataInicio: '2099-10-03T16:00:00.000Z' });
    expect(partidas.recalcularPeriodo).toHaveBeenCalledWith(tx, 7);
    desafio.update.mockClear();
    await expect(service.atualizar(7, { limiteParticipantes: 0 })).rejects.toBeInstanceOf(BadRequestException);
    expect(desafio.update).not.toHaveBeenCalled();
  });

  it.each(['ABERTO', 'EM_ANDAMENTO', 'ENCERRADO', 'CANCELADO'])('nao edita nem publica %s', async status => {
    desafio.findUnique.mockResolvedValue(row({ status }));
    await expect(service.atualizar(7, { nome: 'Novo' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.publicar(7)).rejects.toBeInstanceOf(ConflictException);
    expect(desafio.update).not.toHaveBeenCalled();
  });

  it('publica depois de revalidar partidas e preenche publicadoEm com horario atual', async () => {
    const inicio = Date.now();
    const result = await service.publicar(7);
    expect(result.status).toBe('ABERTO');
    expect(partidas.prepararPublicacao).toHaveBeenCalledWith(7);
    expect(partidas.aplicarPublicacao).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 7 }), expect.any(Object));
    expect(partidas.aplicarPublicacao.mock.invocationCallOrder[0]).toBeLessThan(desafio.update.mock.invocationCallOrder[0]);
    const publicadoEm = new Date(result.publicadoEm as string).getTime();
    expect(publicadoEm).toBeGreaterThanOrEqual(inicio);
    expect(publicadoEm).toBeLessThanOrEqual(Date.now());
    expect(desafio.update.mock.calls[0][0].data).toMatchObject({ status: 'ABERTO', publicadoEm: expect.any(Date), inicioInscricao: new Date(result.publicadoEm as string) });
  });

  it.each([
    { nome: '' }, { tipoAcesso: 'INVALIDO' }, { valorInscricao: new Prisma.Decimal('1') },
    { tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal('0') },
    { limiteParticipantes: 0 },
  ])('nao publica configuracao invalida persistida: %j', async change => {
    desafio.findUnique.mockResolvedValue(row(change));
    await expect(service.publicar(7)).rejects.toBeInstanceOf(BadRequestException);
    expect(desafio.update).not.toHaveBeenCalled();
  });

  it.each(['RASCUNHO', 'ABERTO'])('cancela %s alterando somente status', async status => {
    desafio.findUnique.mockResolvedValue(row({ status, dataInicio: new Date('2099-10-02T00:00:00Z') }));
    await expect(service.cancelar(7)).resolves.toMatchObject({ status: 'CANCELADO' });
    expect(desafio.update.mock.calls[0][0].data).toEqual({ status: 'CANCELADO' });
    // O cliente de transacao nao possui exclusao, inscricoes ou operacoes financeiras.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['EM_ANDAMENTO', 'ENCERRADO', 'CANCELADO'])('nao cancela %s', async status => {
    desafio.findUnique.mockResolvedValue(row({ status }));
    await expect(service.cancelar(7)).rejects.toBeInstanceOf(ConflictException);
    expect(desafio.update).not.toHaveBeenCalled();
  });

  it.each(['atualizar', 'publicar', 'cancelar'] as const)('bloqueia registro antes de ler e escrever em %s', async acao => {
    await service[acao](7, {});
    const [sql, id] = tx.$queryRaw.mock.calls[0];
    expect(sql.join('?')).toContain('SELECT ID FROM DESAFIO WHERE ID = ? FOR UPDATE');
    expect(id).toBe(7);
    const leituraProtegida = desafio.findUnique.mock.invocationCallOrder[acao === 'publicar' ? 1 : 0];
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(leituraProtegida);
    expect(leituraProtegida).toBeLessThan(desafio.update.mock.invocationCallOrder[0]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted' });
  });

  it('consulta por ID e seleciona somente identidade segura do criador', async () => {
    await expect(service.buscar(7)).resolves.toMatchObject({ id: 7, criadoPor: { idUsuario: 42, nome: 'Admin' } });
    expect(desafio.findUnique.mock.calls[0][0].select.criadoPor.select).toEqual({ idUsuario: true, nome: true });
  });

  it('lista mais recentes com filtros e paginacao administrativa', async () => {
    const result = await service.listar({ pagina: 2, limite: 10, status: DesafioStatus.RASCUNHO, tipoAcesso: DesafioTipoAcesso.FREE });
    expect(desafio.findMany.mock.calls[0][0]).toMatchObject({ skip: 10, take: 10,
      where: { status: 'RASCUNHO', tipoAcesso: 'FREE' }, orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }] });
    expect(desafio.count).toHaveBeenCalledWith({ where: { status: 'RASCUNHO', tipoAcesso: 'FREE' } });
    expect(result).toMatchObject({ itens: [{ id: 7 }], paginacao: { pagina: 2, limite: 10, total: 1, totalPaginas: 1 } });
  });

  it('retorna pagina vazia sem filtros', async () => {
    desafio.findMany.mockResolvedValue([]);
    desafio.count.mockResolvedValue(0);
    await expect(service.listar({ pagina: 1, limite: 20 })).resolves.toEqual({ itens: [],
      paginacao: { pagina: 1, limite: 20, total: 0, totalPaginas: 0 } });
    expect(desafio.count).toHaveBeenCalledWith({ where: {} });
  });

  it('filtros administrativos acompanham o status derivado no kickoff', async () => {
    await service.listar({ pagina: 1, limite: 20, status: 'ABERTO' });
    expect(desafio.count).toHaveBeenLastCalledWith({ where: { status: 'ABERTO', dataInicio: { gt: expect.any(Date) } } });
    await service.listar({ pagina: 1, limite: 20, status: 'EM_ANDAMENTO' });
    expect(desafio.count).toHaveBeenLastCalledWith({ where: { OR: [
      { status: 'EM_ANDAMENTO' }, { status: 'ABERTO', dataInicio: { lte: expect.any(Date) } },
    ] } });
  });

  it('retorna 404 na consulta e em todas as mutacoes de ID inexistente', async () => {
    desafio.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.buscar(999)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.atualizar(999, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.publicar(999)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cancelar(999)).rejects.toBeInstanceOf(NotFoundException);
    expect(desafio.update).not.toHaveBeenCalled();
  });
});
