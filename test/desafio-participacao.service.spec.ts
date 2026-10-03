import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { desafioParticipacaoFixture } from './helpers/desafio-participacao.fixture';

const erro = (code: string) => expect.objectContaining({ response: expect.objectContaining({ statusCode: 409, code }) });

describe('Participacao no Desafio com CarteiraService real e persistencia simulada', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2030-10-01T12:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('FREE cria inscricao ATIVA com zero e nao acessa carteira nem movimentacao', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.tipoAcesso = 'FREE'; f.desafio.valorInscricao = new Prisma.Decimal(0);
    f.state.carteiras = [];
    const palpites = f.state.palpites.map(p => ({ ...p }));
    const result = await f.service.participar(7, 42);
    expect(result).toEqual({ inscricao: { id: expect.any(Number), desafioId: 7, status: 'ATIVA', numero: 1, nome: 'Palpite 1',
      valorInscricao: '0.00', dataInscricao: f.agora.toISOString() }, tipoAcesso: 'FREE', valorCobrado: '0.00' });
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toHaveLength(1);
    expect(f.state.inscricoes[0]).toMatchObject({ usuarioId: 42, status: 'ATIVA', movimentacaoDebitoId: null });
    expect(f.state.inscricoes[0].valorInscricao.isZero()).toBe(true);
    expect(f.tx.carteira.findUnique).not.toHaveBeenCalled();
    expect(f.tx.carteira.upsert).not.toHaveBeenCalled();
    expect(f.tx.carteira.update).not.toHaveBeenCalled();
    expect(f.tx.movimentacaoCarteira.create).not.toHaveBeenCalled();
    expect(f.state.palpites).toEqual(palpites);
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('PAGO debita, registra INSCRICAO e vincula movimento na mesma transacao sem expor dados internos', async () => {
    const f = desafioParticipacaoFixture();
    const debitar = jest.spyOn(f.carteiras, 'debitarEmTransacao');
    const palpites = f.state.palpites.map(p => ({ ...p }));
    const result = await f.service.participar(7, 42);
    expect(result).toMatchObject({ tipoAcesso: 'PAGO', valorCobrado: '2.00', inscricao: { status: 'ATIVA', valorInscricao: '2.00' } });
    expect(result.inscricao).not.toHaveProperty('movimentacaoDebitoId');
    expect(result.inscricao).not.toHaveProperty('usuarioId');
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 20000 });
    expect(debitar).toHaveBeenCalledWith(f.tx, { usuarioId: 42, valor: new Prisma.Decimal('2.00'), origem: 'INSCRICAO',
      referenciaId: 'desafio:7:inscricao:7042', descricao: 'Participacao no Desafio 7 - Palpite 1' });
    expect(f.state.movimentos).toHaveLength(1);
    const movimento = f.state.movimentos[0];
    expect(movimento).toMatchObject({ tipo: 'DEBITO', origem: 'INSCRICAO', status: 'CONFIRMADA', carteiraId: 42 });
    expect(movimento.valor.toFixed(2)).toBe('2.00');
    expect(movimento.saldoAnterior.toFixed(2)).toBe('10.00');
    expect(movimento.saldoPosterior.toFixed(2)).toBe('8.00');
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe('8.00');
    expect(f.state.inscricoes[0].movimentacaoDebitoId).toBe(movimento.id);
    const queries = f.tx.$queryRaw.mock.calls.map(([sql]: [TemplateStringsArray]) => sql.join('?'));
    expect(queries[0]).toContain('FROM DESAFIO');
    expect(queries[1]).toContain('FROM USUARIO');
    expect(queries[2]).toContain('FROM CARTEIRA');
    expect(f.state.palpites).toEqual(palpites);
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('usa snapshot atual e aritmetica decimal com saldo exatamente suficiente', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.valorInscricao = new Prisma.Decimal('0.30');
    f.state.carteiras[0].saldoDisponivel = new Prisma.Decimal('0.30');
    expect((await f.service.participar(7, 42)).valorCobrado).toBe('0.30');
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe('0.00');
    expect(f.state.inscricoes[0].valorInscricao.toFixed(2)).toBe('0.30');
  });

  it.each([false, true])('saldo insuficiente retorna contrato sem qualquer escrita; carteira ausente=%s', async ausente => {
    const f = desafioParticipacaoFixture();
    if (ausente) f.state.carteiras = [];
    else { f.state.carteiras[0].saldoDisponivel = new Prisma.Decimal('1.25'); f.state.carteiras[0].saldoBloqueado = new Prisma.Decimal('100'); }
    await expect(f.service.participar(7, 42)).rejects.toMatchObject({ response: {
      statusCode: 409, code: 'SALDO_INSUFICIENTE', message: expect.stringContaining('Adicione saldo'),
      saldoDisponivel: ausente ? '0.00' : '1.25', valorNecessario: '2.00', valorFaltante: ausente ? '2.00' : '0.75', moeda: 'BRL',
    } });
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]);
    expect(f.state.movimentos).toEqual([]);
    expect(f.tx.carteira.update).not.toHaveBeenCalled();
    expect(f.tx.carteira.upsert).not.toHaveBeenCalled();
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('rejeita carteira bloqueada antes de debitar', async () => {
    const f = desafioParticipacaoFixture(); f.state.carteiras[0].status = 'BLOQUEADA';
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro('CARTEIRA_BLOQUEADA'));
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]); expect(f.state.movimentos).toEqual([]);
  });

  it('palpites de outro usuario/desafio nao completam os obrigatorios e nada e preenchido automaticamente', async () => {
    const f = desafioParticipacaoFixture();
    f.state.palpites = f.state.palpites.filter(p => p.usuarioId !== 42 || p.desafioPartidaId === 1);
    f.state.palpites.push({ desafioId: 8, usuarioId: 42, desafioPartidaId: 2, palpite: 'FORA' });
    await expect(f.service.participar(7, 42)).rejects.toMatchObject({ response: { code: 'PALPITES_INCOMPLETOS', partidaIds: [2] } });
    expect(f.tx.carteira.findUnique).not.toHaveBeenCalled();
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]); expect(f.state.movimentos).toEqual([]);
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('nao exige palpite para ANULADA, mas rejeita Desafio sem partidas elegiveis', async () => {
    const f = desafioParticipacaoFixture(); f.state.partidas[1].status = 'ANULADA';
    f.state.palpites = f.state.palpites.filter(p => p.desafioPartidaId === 1);
    await expect(f.service.participar(7, 42)).resolves.toMatchObject({ inscricao: { status: 'ATIVA' } });
    f.state.partidas[0].status = 'ANULADA';
    await expect(f.service.participar(7, 43)).rejects.toEqual(erro('SEM_PARTIDAS_ELEGIVEIS'));
    f.state.partidas = [];
    await expect(f.service.participar(7, 43)).rejects.toEqual(erro('SEM_PARTIDAS_ELEGIVEIS'));
  });

  it('repeticao retorna inscricao original, mesmo apos prazo/preco/status mudarem, sem novo debito', async () => {
    const f = desafioParticipacaoFixture();
    const original = await f.service.participar(7, 42);
    f.desafio.valorInscricao = new Prisma.Decimal('9'); f.desafio.status = 'ENCERRADO';
    jest.setSystemTime(f.desafio.dataFim);
    expect(await f.service.participar(7, 42)).toEqual(original);
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toHaveLength(1); expect(f.state.movimentos).toHaveLength(1);
    expect(f.tx.carteira.update).toHaveBeenCalledTimes(1);
  });

  it('nao reativa inscricao cancelada nem cobra novamente', async () => {
    const f = desafioParticipacaoFixture(); f.state.inscricoes[0].status = 'CANCELADA';
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro('INSCRICAO_CANCELADA'));
    expect(f.tx.carteira.update).not.toHaveBeenCalled(); expect(f.state.movimentos).toEqual([]);
  });

  it('limite conta apenas ATIVA e impede a proxima entrada', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.limiteParticipantes = 1;
    f.state.inscricoes.push({ desafioId: 7, usuarioId: 99, status: 'CANCELADA' });
    await f.service.participar(7, 42);
    await expect(f.service.participar(7, 43)).rejects.toEqual(erro('LIMITE_PARTICIPANTES_ATINGIDO'));
    expect(f.state.movimentos).toHaveLength(1);
    expect(f.state.carteiras[1].saldoDisponivel.toFixed(2)).toBe('10.00');
  });

  it.each(['RASCUNHO', 'EM_ANDAMENTO', 'ENCERRADO', 'CANCELADO'])('rejeita novas participacoes no status %s', async status => {
    const f = desafioParticipacaoFixture(); f.desafio.status = status;
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro('DESAFIO_INDISPONIVEL'));
    expect(f.state.movimentos).toEqual([]); expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]);
  });

  it.each(['inicioInscricao', 'fimInscricao', 'dataInicio', 'dataFim', 'publicadoEm', 'naoPublicado'])
  ('rejeita periodo invalido: %s', async campo => {
    const f = desafioParticipacaoFixture();
    if (campo === 'naoPublicado') f.desafio.publicadoEm = null;
    else f.desafio[campo] = new Date(+f.agora + (['inicioInscricao', 'publicadoEm'].includes(campo) ? 1 : 0));
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro(['publicadoEm', 'naoPublicado'].includes(campo)
      ? 'DESAFIO_INDISPONIVEL' : 'FORA_JANELA_INSCRICAO'));
    expect(f.state.movimentos).toEqual([]); expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]);
  });

  it('aceita inicio inclusivo e 1ms antes do fim, bloqueando exatamente no fim', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.inicioInscricao = f.agora; f.desafio.fimInscricao = new Date(+f.agora + 1);
    await f.service.participar(7, 42);
    jest.setSystemTime(f.desafio.fimInscricao);
    await expect(f.service.participar(7, 43)).rejects.toEqual(erro('FORA_JANELA_INSCRICAO'));
  });

  it.each([{ status: 'EM_ANDAMENTO' }, { status: 'FINALIZADA' }, { dataInicio: new Date('2030-10-01T12:00:00Z') },
    { resultado: 'CASA' }, { golsMandante: 0 }, { golsVisitante: 0 }])('impede entrada tardia/partida nao elegivel: %j', async change => {
    const f = desafioParticipacaoFixture(); Object.assign(f.state.partidas[0], change);
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro('PARTIDAS_INDISPONIVEIS'));
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]); expect(f.state.movimentos).toEqual([]);
  });

  it.each([['FREE', '2'], ['PAGO', '0'], ['PAGO', '-1'], ['PAGO', '0.001'], ['PAGO', '10000000000']])
  ('rejeita configuracao financeira invalida %s/%s antes de cobrar', async (tipoAcesso, valor) => {
    const f = desafioParticipacaoFixture(); Object.assign(f.desafio, { tipoAcesso, valorInscricao: new Prisma.Decimal(valor) });
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro('VALOR_INSCRICAO_INVALIDO'));
    expect(f.tx.carteira.update).not.toHaveBeenCalled();
  });

  it('revalida existencia e usuario ativo sob lock', async () => {
    const f = desafioParticipacaoFixture();
    await expect(f.service.participar(999, 42)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.participar(7, 999)).rejects.toBeInstanceOf(NotFoundException);
    f.state.usuarios[0].status = 'INATIVO';
    await expect(f.service.participar(7, 42)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.state.movimentos).toEqual([]);
  });

  it.each(['saldo', 'movimento', 'inscricao'])('rollback integral quando falha depois de escrever %s', async etapa => {
    const f = desafioParticipacaoFixture();
    const mock = etapa === 'saldo' ? f.tx.carteira.update : etapa === 'movimento' ? f.tx.movimentacaoCarteira.create : f.tx.desafioInscricao.update;
    const original = mock.getMockImplementation();
    mock.mockImplementationOnce(async (args: unknown) => { await original(args); throw new Error('falha simulada'); });
    await expect(f.service.participar(7, 42)).rejects.toThrow('falha simulada');
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe('10.00');
    expect(f.state.movimentos).toEqual([]); expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]);
    await expect(f.service.participar(7, 42)).resolves.toMatchObject({ valorCobrado: '2.00' });
    expect(f.state.movimentos).toHaveLength(1);
  });

  it('rollback do debito se a escrita da inscricao atravessa o prazo', async () => {
    const f = desafioParticipacaoFixture(); const criar = f.tx.desafioInscricao.update.getMockImplementation();
    f.tx.desafioInscricao.update.mockImplementationOnce(async (args: unknown) => {
      const row = await criar(args); jest.setSystemTime(f.desafio.fimInscricao); return row;
    });
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro('FORA_JANELA_INSCRICAO'));
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe('10.00');
    expect(f.state.movimentos).toEqual([]); expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]);
  });

  it.each(['P2002', 'P2034', 'P2028'])('constraint/conflito %s aborta toda a transacao', async code => {
    const f = desafioParticipacaoFixture();
    f.tx.desafioInscricao.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('conflito', { code, clientVersion: 'test' }));
    await expect(f.service.participar(7, 42)).rejects.toEqual(erro(code === 'P2002' ? 'INSCRICAO_DUPLICADA' : 'PARTICIPACAO_CONCORRENTE'));
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe('10.00');
    expect(f.state.movimentos).toEqual([]); expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toEqual([]);
  });

  it('requisicoes simultaneas do mesmo usuario geram uma inscricao e um debito', async () => {
    const f = desafioParticipacaoFixture();
    const results = await Promise.all(Array.from({ length: 5 }, () => f.service.participar(7, 42)));
    expect(results.every(r => r.inscricao.id === results[0].inscricao.id)).toBe(true);
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toHaveLength(1); expect(f.state.movimentos).toHaveLength(1);
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe('8.00');
  });

  it('duas entradas simultaneas disputam a ultima vaga sem exceder limite nem cobrar perdedor', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.limiteParticipantes = 1;
    const results = await Promise.allSettled([f.service.participar(7, 42), f.service.participar(7, 43)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const falha = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(falha.reason).toEqual(erro('LIMITE_PARTICIPANTES_ATINGIDO'));
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toHaveLength(1); expect(f.state.movimentos).toHaveLength(1);
    expect(f.state.carteiras.map(c => c.saldoDisponivel.toFixed(2)).sort()).toEqual(['10.00', '8.00']);
  });

  it('mesma carteira em desafios distintos nao permite saldo negativo por concorrencia', async () => {
    const f = desafioParticipacaoFixture(); f.state.carteiras[0].saldoDisponivel = new Prisma.Decimal('2');
    f.state.desafios.push({ ...f.desafio, id: 8 });
    f.state.partidas.push({ ...f.state.partidas[0], id: 3, desafioId: 8 });
    f.state.inscricoes.push({ ...f.state.inscricoes[0], id: 8042, desafioId: 8 });
    f.state.palpites.push({ usuarioId: 42, inscricaoId: 8042, desafioId: 8, desafioPartidaId: 3, palpite: 'EMPATE' });
    const results = await Promise.allSettled([f.service.participar(7, 42), f.service.participar(8, 42)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const falha = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(falha.reason).toEqual(erro('SALDO_INSUFICIENTE'));
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe('0.00');
    expect(f.state.inscricoes.filter(i => i.status === 'ATIVA')).toHaveLength(1); expect(f.state.movimentos).toHaveLength(1);
  });
});
