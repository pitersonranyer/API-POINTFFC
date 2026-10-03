import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { CarteiraService } from '../../src/carteira/carteira.service';
import { DesafioParticipacaoService } from '../../src/desafios/desafio-participacao.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { DesafiosService } from '../../src/desafios/desafios.service';

// Locks por chave e undo por transacao: permite intercalar desafios distintos nos testes.
// Simula persistencia/rollback; nao substitui validacao em MySQL real.
export function desafioParticipacaoFixture() {
  const agora = new Date('2030-10-01T12:00:00Z');
  const desafio: any = { id: 7, nome: 'Desafio', tipoAcesso: 'PAGO', valorInscricao: new Prisma.Decimal('2.00'),
    status: 'ABERTO', publicadoEm: new Date(+agora - 1000), inicioInscricao: new Date(+agora - 1000),
    fimInscricao: new Date(+agora + 3600000), dataInicio: new Date(+agora + 7200000),
    dataFim: new Date(+agora + 86400000), limiteParticipantes: 10, limiteInscricoesPorUsuario: 1 };
  const state: { desafios: any[]; usuarios: any[]; carteiras: any[]; partidas: any[]; palpites: any[]; inscricoes: any[]; movimentos: any[] } = {
    desafios: [desafio], usuarios: [{ idUsuario: 42, status: 'ATIVO' }, { idUsuario: 43, status: 'ATIVO' }],
    carteiras: [42, 43].map(usuarioId => ({ id: usuarioId, usuarioId, status: 'ATIVA', saldoDisponivel: new Prisma.Decimal('10'), saldoBloqueado: new Prisma.Decimal('0') })),
    partidas: [1, 2].map(id => ({ id, desafioId: 7, status: 'AGENDADA', dataInicio: new Date(+agora + 7200000 + id * 1000),
      resultado: null, golsMandante: null, golsVisitante: null })),
    palpites: [42, 43].flatMap(usuarioId => [1, 2].map(desafioPartidaId => ({ usuarioId, inscricaoId: 7000 + usuarioId,
      desafioId: 7, desafioPartidaId, palpite: 'CASA' }))),
    inscricoes: [42, 43].map(usuarioId => ({ id: 7000 + usuarioId, desafioId: 7, usuarioId,
      sequencia: 1, chaveIdempotencia: null, status: 'RASCUNHO', valorInscricao: new Prisma.Decimal(0), dataInscricao: agora })), movimentos: [],
  };
  type Contexto = { chaves: Set<string>; liberar: Array<() => void>; desfazer: Array<() => void> };
  const storage = new AsyncLocalStorage<Contexto>();
  const locks = new Map<string, Promise<void>>();
  async function lock(chave: string) {
    const ctx = storage.getStore()!;
    if (ctx.chaves.has(chave)) return;
    const anterior = locks.get(chave) ?? Promise.resolve();
    let liberar!: () => void;
    locks.set(chave, new Promise<void>(resolve => { liberar = resolve; }));
    await anterior;
    ctx.chaves.add(chave); ctx.liberar.push(liberar);
  }
  const undo = (acao: () => void) => storage.getStore()!.desfazer.push(acao);
  let proximoId = 100;
  const proibido = jest.fn(() => { throw new Error('Palpites/PIX nao podem ser escritos pela participacao'); });
  const tx: any = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, id: number, desafioId?: number) => {
      const query = sql.join('?');
      if (!query.includes('FOR UPDATE')) throw new Error('Lock obrigatorio');
      if (query.includes('FROM DESAFIO_PARTIDA ')) {
        await lock(`partida:${id}`);
        return state.partidas.some(p => p.id === id && p.desafioId === desafioId) ? [{ ID: BigInt(id) }] : [];
      }
      if (query.includes('FROM DESAFIO ')) {
        await lock(`desafio:${id}`); return state.desafios.some(d => d.id === id) ? [{ ID: BigInt(id) }] : [];
      }
      if (query.includes('FROM USUARIO ')) {
        await lock(`usuario:${id}`); return state.usuarios.some(u => u.idUsuario === id) ? [{ id_usuario: BigInt(id) }] : [];
      }
      if (query.includes('FROM CARTEIRA ')) {
        await lock(`carteira:${id}`); return state.carteiras.filter(c => c.usuarioId === id).map(c => ({ ...c }));
      }
      throw new Error(`SQL inesperado: ${query}`);
    }),
    usuario: { findUnique: jest.fn(async ({ where }) => state.usuarios.find(u => u.idUsuario === where.idUsuario) ?? null) },
    desafio: { findUnique: jest.fn(async ({ where }) => state.desafios.find(d => d.id === where.id) ?? null) },
    desafioPartida: { findMany: jest.fn(async ({ where }) => state.partidas.filter(p => p.desafioId === where.desafioId
      && p.status !== where.status.not)),
    findFirst: jest.fn(async ({ where }) => state.partidas.find(p => p.id === where.id && p.desafioId === where.desafioId) ?? null) },
    desafioPalpite: { findMany: jest.fn(async ({ where }) => state.palpites.filter(p => p.desafioId === where.desafioId
      && p.usuarioId === where.usuarioId && p.inscricaoId === where.inscricaoId && where.desafioPartidaId.in.includes(p.desafioPartidaId))),
    create: proibido, update: proibido, upsert: jest.fn(async ({ where, create, update }) => {
      const key = where.inscricaoId_desafioPartidaId;
      const old = state.palpites.find(p => p.inscricaoId === key.inscricaoId && p.desafioPartidaId === key.desafioPartidaId);
      if (old) {
        const backup = { ...old }; undo(() => Object.assign(old, backup)); Object.assign(old, update); return old;
      }
      const row = { id: ++proximoId, pontos: null, apurado: false, ...create }; state.palpites.push(row);
      undo(() => { state.palpites = state.palpites.filter(p => p !== row); }); return row;
    }) },
    carteira: {
      findUnique: jest.fn(async ({ where }) => state.carteiras.find(c => c.usuarioId === where.usuarioId) ?? null),
      upsert: jest.fn(async ({ where }) => {
        const carteira = state.carteiras.find(c => c.usuarioId === where.usuarioId);
        if (!carteira) throw new Error('Este fluxo nao deve criar carteira');
        return carteira;
      }),
      update: jest.fn(async ({ where, data }) => {
        const anterior = state.carteiras.find(c => c.id === where.id);
        undo(() => { state.carteiras = state.carteiras.map(c => c.id === where.id ? anterior : c); });
        const row = { ...anterior, ...data };
        state.carteiras = state.carteiras.map(c => c.id === where.id ? row : c); return row;
      }),
    },
    movimentacaoCarteira: { create: jest.fn(async ({ data }) => {
      const row = { id: ++proximoId, ...data }; state.movimentos.push(row);
      undo(() => { state.movimentos = state.movimentos.filter(m => m.id !== row.id); }); return row;
    }) },
    desafioInscricao: {
      findUnique: jest.fn(async ({ where }) => {
        const key = where.desafioId_usuarioId_sequencia ?? where.desafioId_usuarioId_chaveIdempotencia;
        return state.inscricoes.find(i => i.desafioId === key.desafioId && i.usuarioId === key.usuarioId
          && (key.sequencia === undefined || i.sequencia === key.sequencia)
          && (key.chaveIdempotencia === undefined || i.chaveIdempotencia === key.chaveIdempotencia)) ?? null;
      }),
      findFirst: jest.fn(async ({ where, orderBy }) => state.inscricoes.filter(i => i.desafioId === where.desafioId
        && i.usuarioId === where.usuarioId && (where.id === undefined || i.id === where.id))
        .sort((a, b) => orderBy?.sequencia === 'desc' ? b.sequencia - a.sequencia : a.sequencia - b.sequencia)[0] ?? null),
      count: jest.fn(async ({ where }) => state.inscricoes.filter(i => i.desafioId === where.desafioId && i.status === where.status
        && (where.usuarioId === undefined || i.usuarioId === where.usuarioId)).length),
      create: jest.fn(async ({ data }) => {
        if (state.inscricoes.some(i => i.desafioId === data.desafioId && i.usuarioId === data.usuarioId && i.sequencia === data.sequencia)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        const row = { id: ++proximoId, dataInscricao: agora, ...data }; state.inscricoes.push(row);
        undo(() => { state.inscricoes = state.inscricoes.filter(i => i.id !== row.id); }); return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const old = state.inscricoes.find(i => i.id === where.id);
        const backup = { ...old }; undo(() => Object.assign(old, backup)); Object.assign(old, data); return old;
      }),
    },
    recargaCarteira: { create: proibido, update: proibido },
  };
  const prisma: any = { $transaction: jest.fn(async callback => {
    const ctx: Contexto = { chaves: new Set(), liberar: [], desfazer: [] };
    return storage.run(ctx, async () => {
      try { return await callback(tx); }
      catch (error) { ctx.desfazer.reverse().forEach(acao => acao()); throw error; }
      finally { ctx.liberar.reverse().forEach(acao => acao()); }
    });
  }) };
  const carteiras = new CarteiraService(prisma as PrismaService);
  const service = new DesafioParticipacaoService(prisma as PrismaService, carteiras);
  return { agora, desafio, state, tx, prisma, carteiras, service, proibido,
    desafios: new DesafiosService(prisma as PrismaService) };
}
