import { Prisma, RecargaCarteiraStatus } from '@prisma/client';
import { RecargaCarteiraService } from '../src/carteira/recarga-carteira.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('RecargaCarteiraService', () => {
  let service: RecargaCarteiraService;
  let prisma: any;
  let recargas: any;
  const input = { carteiraId: 1, valor: '10.25', provedor: 'TESTE' };
  const erroPrisma = (code: string) => new Prisma.PrismaClientKnownRequestError('Erro de persistência', { code, clientVersion: '5.22.0' });

  beforeEach(() => {
    recargas = {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data })),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    // Qualquer tentativa de acessar saldo ou movimentação falha: apenas recargas estão disponíveis.
    prisma = { recargaCarteira: recargas, $transaction: jest.fn((callback) => callback({ recargaCarteira: recargas })) };
    service = new RecargaCarteiraService(prisma as PrismaService);
  });

  it('cria pendente com Decimal e referência gerada, sem saldo nem movimentação', async () => {
    const result = await service.criar(input);
    expect(result.status).toBe('PENDENTE');
    expect(result.valor).toBeInstanceOf(Prisma.Decimal);
    expect(result.valor.toString()).toBe('10.25');
    expect(result.externalReference).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.idPagamentoExterno).toBeUndefined();
    expect(recargas.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('aceita referência e pagamento fornecidos na criação', async () => {
    const result = await service.criar({ ...input, valor: new Prisma.Decimal('0.01'), externalReference: 'ref-1', idPagamentoExterno: 'pag-1' });
    expect(result).toMatchObject({ externalReference: 'ref-1', idPagamentoExterno: 'pag-1' });
    expect(result.valor.toString()).toBe('0.01');
  });

  it.each(['0', '-1', '1.001', '1.000', 'abc', 'NaN', 'Infinity', '10000000000', '', new Prisma.Decimal('-1'), new Prisma.Decimal('0.001'), new Prisma.Decimal('NaN'), 1.25])('rejeita valor inválido %s', async (valor) => {
    await expect(service.criar({ ...input, valor: valor as string })).rejects.toThrow();
    expect(recargas.create).not.toHaveBeenCalled();
  });

  it.each([{ carteiraId: 0 }, { provedor: '' }, { provedor: 'x'.repeat(51) }, { externalReference: '' }, { idPagamentoExterno: '' }])('valida identificação %j', async (fields) => {
    await expect(service.criar({ ...input, ...fields })).rejects.toThrow();
    expect(recargas.create).not.toHaveBeenCalled();
  });

  it.each(['externalReference', 'idPagamentoExterno'])('traduz conflito de unicidade de %s', async (campo) => {
    recargas.create.mockRejectedValue(erroPrisma('P2002'));
    await expect(service.criar({ ...input, [campo]: 'duplicado' })).rejects.toThrow('já cadastrado');
  });

  it('rejeita carteira inexistente pela chave estrangeira', async () => {
    recargas.create.mockRejectedValue(erroPrisma('P2003'));
    await expect(service.criar(input)).rejects.toThrow('Carteira não encontrada');
  });

  it('consulta pelas três chaves únicas e retorna null quando ausente', async () => {
    expect(await service.consultarPorId(1)).toBeNull();
    expect(await service.consultarPorExternalReference('ref')).toBeNull();
    expect(await service.consultarPorIdPagamentoExterno('pag')).toBeNull();
    expect(recargas.findUnique.mock.calls).toEqual([
      [{ where: { id: 1 } }], [{ where: { externalReference: 'ref' } }], [{ where: { idPagamentoExterno: 'pag' } }],
    ]);
    recargas.findUnique.mockResolvedValue({ id: 1 });
    expect(await service.consultarPorId(1)).toEqual({ id: 1 });
  });

  it('preenche pagamento e PIX posteriormente sem alterar valor ou status', async () => {
    const pix = { idPagamentoExterno: 'pag', pixCopiaCola: 'codigo', qrCode: 'base64', expiracao: new Date('2026-10-01T12:00:00Z') };
    await service.atualizarDadosPix(1, pix);
    expect(recargas.update).toHaveBeenCalledWith({ where: { id: 1 }, data: pix });
  });

  it('atualiza PIX parcialmente e permite limpar campos opcionais', async () => {
    await service.atualizarDadosPix(1, { qrCode: null });
    expect(recargas.update).toHaveBeenCalledWith({ where: { id: 1 }, data: {
      idPagamentoExterno: undefined, pixCopiaCola: undefined, qrCode: null, expiracao: undefined,
    } });
  });

  it('rejeita pagamento duplicado na atualização', async () => {
    recargas.update.mockRejectedValue(erroPrisma('P2002'));
    await expect(service.atualizarDadosPix(1, { idPagamentoExterno: 'pag' })).rejects.toThrow('já cadastrado');
  });

  it('rejeita expiração inválida', async () => {
    await expect(service.atualizarDadosPix(1, { expiracao: new Date('invalid') })).rejects.toThrow('Expiração inválida');
    expect(recargas.update).not.toHaveBeenCalled();
  });

  it.each(Object.values(RecargaCarteiraStatus))('persiste status %s sem operações financeiras', async (status) => {
    await service.atualizarStatus(1, status);
    expect(recargas.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { status } });
    if (status === 'APROVADA') {
      expect(recargas.updateMany).toHaveBeenCalledWith({ where: { id: 1, aprovadoEm: null }, data: { aprovadoEm: expect.any(Date) } });
    } else {
      expect(recargas.updateMany).not.toHaveBeenCalled();
    }
    expect(recargas.create).not.toHaveBeenCalled();
  });

  it('preserva primeira aprovação em repetição e reembolso', async () => {
    const registro = { aprovadoEm: null as Date | null, status: 'PENDENTE' };
    recargas.updateMany.mockImplementation(({ where, data }: { where: { aprovadoEm: null }; data: { aprovadoEm: Date } }) => {
      if (registro.aprovadoEm === where.aprovadoEm) registro.aprovadoEm = data.aprovadoEm;
      return Promise.resolve({ count: 1 });
    });
    recargas.update.mockImplementation(({ data }: { data: { status: RecargaCarteiraStatus } }) => Promise.resolve(Object.assign(registro, data)));
    await service.atualizarStatus(1, 'APROVADA');
    const primeira = registro.aprovadoEm;
    await service.atualizarStatus(1, 'APROVADA');
    await service.atualizarStatus(1, 'REEMBOLSADA');
    expect(registro.aprovadoEm).toBe(primeira);
    expect(primeira).toBeInstanceOf(Date);
  });

  it('rejeita status desconhecido', async () => {
    await expect(service.atualizarStatus(1, 'OUTRO' as RecargaCarteiraStatus)).rejects.toThrow('Status inválido');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('traduz recarga inexistente nas atualizações', async () => {
    recargas.update.mockRejectedValue(erroPrisma('P2025'));
    await expect(service.atualizarStatus(1, 'APROVADA')).rejects.toThrow('Recarga não encontrada');
    await expect(service.atualizarDadosPix(1, { qrCode: 'pix' })).rejects.toThrow('Recarga não encontrada');
  });

  it('propaga falhas inesperadas do banco', async () => {
    recargas.create.mockRejectedValue(new Error('Banco indisponível'));
    await expect(service.criar(input)).rejects.toThrow('Banco indisponível');
  });

  it('não permite alterar recarga Mercado Pago fora do fluxo oficial', async () => {
    recargas.findUnique.mockResolvedValue({ id: 1, provedor: 'MERCADO_PAGO' });
    await expect(service.atualizarStatus(1, 'APROVADA')).rejects.toThrow('fluxo oficial PIX');
    await expect(service.atualizarDadosPix(1, { idPagamentoExterno: 'ORDOTHER' })).rejects.toThrow('fluxo oficial PIX');
    expect(recargas.update).not.toHaveBeenCalled();
  });
});
