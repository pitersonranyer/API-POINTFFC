import { Prisma } from '@prisma/client';
import { lotesFixture } from './helpers/lotes-inscricao.fixture';
import { TelegramSelectionResponse, TelegramSelectionService } from '../src/telegram/telegram-selection.service';
import { TelegramCompetitionsService } from '../src/telegram/telegram-competitions.service';
import { TelegramLinkService } from '../src/telegram-link/telegram-link.service';
import { TelegramWalletService } from '../src/telegram/telegram-wallet.service';
import { MeusTimesService } from '../src/meus-times/meus-times.service';
import { InscricoesCompeticaoService } from '../src/ligas-competicoes/inscricoes-competicao.service';
import { CartolaService } from '../src/cartola/cartola.service';

describe('Paid Telegram enrollment with the existing transactional services', () => {
  let f: ReturnType<typeof lotesFixture>;
  let service: TelegramSelectionService;
  let available: boolean;
  let linkedUser: number | null;
  let wallet: { consultar: jest.Mock; validarValor: jest.Mock; preparar: jest.Mock; confirmar: jest.Mock };
  const user = '54321';
  const button = (response: TelegramSelectionResponse, label: string) => {
    const found = response.inlineKeyboard?.flat().find(item => item.text.startsWith(label));
    if (!found) throw new Error(`Missing ${label}: ${JSON.stringify(response)}`);
    return found.callback_data;
  };
  const press = (data: string) => service.handleCallback({ telegramUserId: user, chatId: user, messageId: 900, data });
  const card = () => ({ id: 1, nome: 'POINT PAGA', tipoAcesso: f.competicao.tipoAcesso,
    valorInscricao: Number(f.competicao.valorInscricao), rodadaInicio: 42, rodadaFim: 42, fimInscricao: null,
    limiteParticipantes: f.competicao.limiteParticipantes, limiteTimesUsuario: f.competicao.limiteTimesUsuario });
  const fresh = () => new TelegramSelectionService(
    { listarDivulgaveis: async () => available ? [card()] : [], buscarElegivel: async () => available ? card() : null,
      contarParticipantesAtivos: async () => f.state.inscricoes.length } as unknown as TelegramCompetitionsService,
    { resolveActiveUserId: async () => linkedUser } as unknown as TelegramLinkService,
    { listarTimesDoUsuario: async () => f.times } as unknown as MeusTimesService,
    { minhas: async () => f.state.inscricoes } as unknown as InscricoesCompeticaoService,
    f.service, {} as CartolaService, wallet as unknown as TelegramWalletService,
  );
  beforeEach(() => {
    f = lotesFixture(); available = true; linkedUser = 10;
    wallet = {
      consultar: jest.fn().mockImplementation(async () => ({ usuarioId: 10, saldoDisponivel: f.state.carteira.saldoDisponivel.toFixed(2),
        saldoBloqueado: '0.00', status: f.state.carteira.status, operation: null })),
      validarValor: jest.fn(),
      preparar: jest.fn().mockResolvedValue({ id: 'pix-request', usuarioId: 10, valor: '15.00', confirmado: false,
        expiraEm: new Date(Date.now() + 600000), recarga: null }),
      confirmar: jest.fn().mockResolvedValue({ id: 91, valor: '15.00', status: 'PENDENTE',
        pixCopiaCola: 'mock-pix', qrCode: null, expiracao: null }),
    };
    service = fresh();
  });
  afterEach(() => jest.restoreAllMocks());
  async function summary(multiple = true) {
    const movementsBeforeSelection = f.state.movimentos.length;
    const page = await service.start(user);
    service.attachInlineMessage(user, page.sessionToken!, user, 900);
    const offer = await press(button(page, '1. POINT PAGA'));
    expect(offer!.text).toContain('10,00');
    const teams = await press(button(offer!, '⚽ Participar'));
    const selected = await press(button(teams!, multiple ? '☑️ Selecionar todos' : '⬜ Time 123'));
    expect(f.state.movimentos).toHaveLength(movementsBeforeSelection);
    return (await press(button(selected!, '➡️ Continuar com selecionados')))!;
  }
  const debitCount = () => f.state.movimentos.filter(row => row.tipo === 'DEBITO').length;

  it.each([false, true])('confirms one atomic paid batch (multiple=%s) only after explicit approval', async (multiple) => {
    const preview = await summary(multiple);
    expect(preview.text).toContain('Valor unitário: R$ 10,00');
    expect(preview.text).toContain(`Valor total: R$ ${multiple ? '20' : '10'},00`);
    expect(preview.text).toContain('Saldo disponível: R$ 100,00');
    expect(f.state.inscricoes).toHaveLength(0);
    const receipt = await press(button(preview, '✅ Confirmar inscrição'));
    expect(receipt!.text).toContain(`Valor debitado: R$ ${multiple ? '20' : '10'},00`);
    expect(receipt!.text).toContain(`Saldo após a operação: R$ ${multiple ? '80' : '90'},00`);
    expect(f.state.inscricoes).toHaveLength(multiple ? 2 : 1);
    expect(debitCount()).toBe(1);
  });

  it('reports the exact shortfall and offers PIX without enabling debit', async () => {
    f.state.carteira.saldoDisponivel = new Prisma.Decimal('5');
    const preview = await summary();
    expect(preview.text).toContain('Disponível: R$ 5,00. Necessário: R$ 20,00. Faltam: R$ 15,00');
    expect(preview.inlineKeyboard!.flat().some(item => item.callback_data.includes(':pay:'))).toBe(false);
    expect(button(preview, '💰 Recarregar carteira')).toBeDefined();
    expect(f.state.movimentos).toHaveLength(0);
  });

  it('charges only the remaining team in a complementary enrollment', async () => {
    await f.service.criar(1, 10, { timesCartolaIds: [123], valorUnitarioEsperado: '10.00' }, 'prior-enrollment-key-1234');
    const preview = await summary();
    expect(preview.text).toContain('Times selecionados: 1');
    expect(preview.text).toContain('Valor total: R$ 10,00');
    expect(preview.text).not.toContain('(#123)');
    await press(button(preview, '✅ Confirmar inscrição'));
    expect(f.state.inscricoes).toHaveLength(2);
    expect(debitCount()).toBe(2);
    expect(f.state.carteira.saldoDisponivel.toFixed(2)).toBe('80.00');
  });

  it('returns from PIX to a fresh quote without automatically enrolling after payment', async () => {
    f.state.carteira.saldoDisponivel = new Prisma.Decimal('5');
    const preview = await summary();
    const home = await press(button(preview, '💰 Recarregar carteira'));
    const input = await press(button(home!, '💰 Adicionar saldo'));
    expect(input!.text).toContain('Informe o valor');
    const pixPreview = await service.handle(user, '15,00');
    const payment = await press(button(pixPreview!, '✅ Confirmar e gerar PIX'));
    expect(wallet.confirmar).toHaveBeenCalledWith(user, 'pix-request');
    await f.carteiras.creditar({ usuarioId: 10, valor: '15.00', origem: 'AJUSTE' });
    f.competicao.valorInscricao = new Prisma.Decimal('7.50');
    expect(f.state.inscricoes).toHaveLength(0);
    expect(debitCount()).toBe(0);
    const renewed = await press(button(payment!, '↩️ Voltar à competição'));
    expect(renewed!.text).toContain('Saldo disponível: R$ 20,00');
    expect(renewed!.text).toContain('Valor total: R$ 15,00');
    expect(f.state.inscricoes).toHaveLength(0);
    await press(button(renewed!, '✅ Confirmar inscrição'));
    expect(f.state.inscricoes).toHaveLength(2);
    expect(debitCount()).toBe(1);
  });

  it('requires another explicit confirmation after a price change', async () => {
    const preview = await summary();
    f.competicao.valorInscricao = new Prisma.Decimal('12.50');
    const changed = await press(button(preview, '✅ Confirmar inscrição'));
    expect(changed!.text).toContain('O preço mudou');
    expect(changed!.text).toContain('Valor total: R$ 25,00');
    expect(debitCount()).toBe(0);
    await press(button(changed!, '✅ Confirmar inscrição'));
    expect(f.state.carteira.saldoDisponivel.toFixed(2)).toBe('75.00');
  });

  it('revalidates saldo at final confirmation', async () => {
    const preview = await summary();
    f.state.carteira.saldoDisponivel = new Prisma.Decimal('1');
    const rejected = await press(button(preview, '✅ Confirmar inscrição'));
    expect(rejected!.text).toContain('Saldo insuficiente');
    expect(f.state.inscricoes).toHaveLength(0);
    expect(debitCount()).toBe(0);
  });

  it('handles insufficient funds detected inside the transaction without partial enrollment', async () => {
    const preview = await summary();
    const original = f.service.criar.bind(f.service);
    jest.spyOn(f.service, 'criar').mockImplementationOnce(async (...args) => {
      f.state.carteira.saldoDisponivel = new Prisma.Decimal('2');
      return original(...args);
    });
    const rejected = await press(button(preview, '✅ Confirmar inscrição'));
    expect(rejected!.text).toContain('Faltam: R$ 18,00');
    expect(button(rejected!, '💰 Recarregar carteira')).toBeDefined();
    expect(f.state.inscricoes).toHaveLength(0);
    expect(f.state.lotes).toHaveLength(0);
    expect(debitCount()).toBe(0);
  });

  it('rejects an expired confirmation without debit or batch creation', async () => {
    jest.useFakeTimers();
    try {
      const preview = await summary();
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      const expired = await press(button(preview, '✅ Confirmar inscrição'));
      expect(expired!.text).toContain('Sua seleção expirou');
      expect(f.state.inscricoes).toHaveLength(0);
      expect(debitCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('drops no team silently when eligibility changes before confirmation', async () => {
    const preview = await summary();
    f.state.inscricoes.push({ timeIdCartola: 123, statusInscricao: 'ATIVA' });
    const changed = await press(button(preview, '✅ Confirmar inscrição'));
    expect(changed!.text).toContain('A elegibilidade ou capacidade mudou');
    expect(f.state.inscricoes).toHaveLength(1);
    expect(debitCount()).toBe(0);
  });

  it.each(['closed', 'unlinked', 'other-user', 'blocked-wallet'])('does not debit when %s', async (state) => {
    const preview = await summary();
    if (state === 'closed') available = false;
    if (state === 'unlinked') linkedUser = null;
    if (state === 'other-user') linkedUser = 99;
    if (state === 'blocked-wallet') f.state.carteira.status = 'BLOQUEADA';
    await press(button(preview, '✅ Confirmar inscrição'));
    expect(f.state.inscricoes).toHaveLength(0);
    expect(debitCount()).toBe(0);
  });

  it('repeated and concurrent callbacks return the same persisted batch with one debit', async () => {
    const preview = await summary();
    const data = button(preview, '✅ Confirmar inscrição');
    const receipts = await Promise.all([press(data), press(data), press(data)]);
    expect(receipts.every(item => item!.text.includes('Valor debitado: R$ 20,00'))).toBe(true);
    expect(f.state.lotes).toHaveLength(1);
    expect(debitCount()).toBe(1);
    service = fresh();
    const recovered = await press(data);
    expect(recovered!.text).toContain('Valor debitado: R$ 20,00');
    expect(debitCount()).toBe(1);
  });

  it('recovers a committed but lost response with the same key after session loss', async () => {
    const preview = await summary();
    const original = f.service.criar.bind(f.service);
    jest.spyOn(f.service, 'criar').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('response lost'); });
    const uncertain = await press(button(preview, '✅ Confirmar inscrição'));
    expect(uncertain!.text).toContain('A operação pode ter sido concluída');
    expect(uncertain!.text).toContain('Saldo consultado antes da tentativa');
    expect(uncertain!.text).not.toContain('nenhuma inscrição foi realizada');
    service = fresh();
    const receipt = await press(button(uncertain!, '✅ Confirmar inscrição'));
    expect(receipt!.text).toContain('Valor debitado: R$ 20,00');
    expect(debitCount()).toBe(1);
  });

  it('rolls back all inscriptions and debit on persistence failure, then retries the same key', async () => {
    const preview = await summary();
    const data = button(preview, '✅ Confirmar inscrição');
    f.tx.movimentacaoCarteira.create.mockRejectedValueOnce(new Error('insert failed'));
    const uncertain = await press(data);
    expect(f.state.inscricoes).toHaveLength(0);
    expect(f.state.lotes).toHaveLength(0);
    expect(debitCount()).toBe(0);
    expect(f.state.carteira.saldoDisponivel.toFixed(2)).toBe('100.00');
    const retry = button(uncertain!, '✅ Confirmar inscrição');
    expect(retry.split(':').at(-1)).toBe(data.split(':').at(-1));
    await press(retry);
    expect(f.state.inscricoes).toHaveLength(2);
    expect(debitCount()).toBe(1);
  });
});
