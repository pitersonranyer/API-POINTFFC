import { Prisma } from '@prisma/client';
import { CarteiraService } from '../../src/carteira/carteira.service';
import { LotesInscricaoService } from '../../src/ligas-competicoes/lotes-inscricao.service';
import { PrismaService } from '../../src/prisma/prisma.service';

// Estado em memoria para testes de contrato e falhas. Locks/rollback reais sao testados na suite MySQL.
export function lotesFixture() {
  let state: { carteira: any; lotes: any[]; inscricoes: any[]; movimentos: any[] } = {
    carteira: { id: 3, usuarioId: 10, status: 'ATIVA', saldoDisponivel: new Prisma.Decimal('100'), saldoBloqueado: new Prisma.Decimal(0) },
    lotes: [], inscricoes: [], movimentos: [],
  };
  const competicao: any = { id: 1, tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal('10'),
    status: 'INSCRICOES_ABERTAS', visivelApp: true, inicioInscricao: null, fimInscricao: null,
    limiteTimesUsuario: 50, limiteParticipantes: 100,
    ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: true }, modalidade: { ativa: true } },
  };
  const times = [123, 456].map(timeId => ({ timeId, usuarioId: 10, nome: `Time ${timeId}`, nomeCartola: null, urlEscudoPng: null }));
  const tx: any = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
      const query = sql.join('?');
      if (query.includes('FROM CARTEIRA')) return [{ ...state.carteira }];
      if (query.includes('FROM USUARIO')) return [{ id_usuario: 10 }];
      return [{ ID: 1 }];
    }),
    usuario: { findUnique: jest.fn(async () => ({ status: 'ATIVO' })) },
    competicaoLiga: { findUniqueOrThrow: jest.fn(async () => competicao) },
    timeUsuario: { findMany: jest.fn(async ({ where }) => times.filter(time => where.timeId.in.includes(time.timeId))) },
    carteira: {
      upsert: jest.fn(async () => state.carteira),
      update: jest.fn(async ({ data }) => { state.carteira = { ...state.carteira, ...data }; return state.carteira; }),
    },
    movimentacaoCarteira: { create: jest.fn(async ({ data }) => {
      const row = { id: state.movimentos.length + 1, ...data }; state.movimentos.push(row); return row;
    }) },
    inscricaoTimeCompeticao: {
      findMany: jest.fn(async ({ where }) => state.inscricoes.filter(row => row.competicaoLigaId === where.competicaoLigaId
        && where.timeIdCartola.in.includes(row.timeIdCartola))),
      count: jest.fn(async ({ where }) => state.inscricoes.filter(row => row.competicaoLigaId === where.competicaoLigaId
        && row.statusInscricao === where.statusInscricao && (where.usuarioId === undefined || row.usuarioId === where.usuarioId)).length),
      create: jest.fn(async ({ data }) => {
        const row = { id: state.inscricoes.length + 1, ...data }; state.inscricoes.push(row); return row;
      }),
    },
    loteInscricao: {
      findUnique: jest.fn(async ({ where }) => state.lotes.find(row => row.usuarioId === where.usuarioId_chaveIdempotenciaHash.usuarioId
        && row.chaveIdempotenciaHash === where.usuarioId_chaveIdempotenciaHash.chaveIdempotenciaHash) ?? null),
      create: jest.fn(async ({ data }) => {
        const row = { id: state.lotes.length + 1, movimentacaoDebitoId: null, confirmadoEm: null, respostaOriginal: null, ...data };
        state.lotes.push(row); return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = state.lotes.find(item => item.id === where.id); Object.assign(row, data); return row;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }) => {
        const row = state.lotes.find(item => item.id === where.id);
        const debito = state.movimentos.find(item => item.id === row.movimentacaoDebitoId);
        return { ...row, inscricoes: state.inscricoes.filter(item => item.loteInscricaoId === row.id).sort((a, b) => a.timeIdCartola - b.timeIdCartola),
          movimentacaoDebito: debito ? { ...debito, carteira: state.carteira } : null };
      }),
    },
  };
  const prisma: any = { $transaction: jest.fn(async callback => {
    const snapshot = { carteira: { ...state.carteira }, lotes: state.lotes.map(row => ({ ...row })),
      inscricoes: state.inscricoes.map(row => ({ ...row })), movimentos: state.movimentos.map(row => ({ ...row })) };
    try { return await callback(tx); } catch (error) { state = snapshot; throw error; }
  }) };
  const carteiras = new CarteiraService(prisma as PrismaService);
  const service = new LotesInscricaoService(prisma as PrismaService, carteiras);
  return { tx, prisma, carteiras, service, competicao, times, get state() { return state; } };
}
