import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { desafioParticipacaoFixture } from './helpers/desafio-participacao.fixture';
import { desafioApuracaoFixture } from './helpers/desafio-apuracao.fixture';

describe('Desafios com cartelas independentes', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2030-10-01T12:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  async function preencher(f: ReturnType<typeof desafioParticipacaoFixture>, inscricaoId: number, palpite: 'CASA' | 'FORA' = 'FORA') {
    for (const p of f.state.partidas) await f.desafios.salvarPalpite(7, p.id, 42, { inscricaoId, palpite });
  }

  it('cria a primeira cartela sem cobrar, preenche e somente depois efetiva', async () => {
    const f = desafioParticipacaoFixture(); f.state.inscricoes = []; f.state.palpites = [];
    const cartela = await f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'primeira' });
    expect(cartela).toMatchObject({ numero: 1, nome: 'Palpite 1', status: 'RASCUNHO' });
    expect(f.state.movimentos).toEqual([]);
    await preencher(f, cartela.id, 'CASA');
    expect((await f.service.participar(7, 42, cartela.id)).inscricao).toMatchObject({ id: cartela.id, status: 'ATIVA' });
    expect(f.state.movimentos).toHaveLength(1);
    expect(f.state.palpites.every(p => p.inscricaoId === cartela.id)).toBe(true);
  });

  it('default 1 mantem Palpite 1 legado e impede efetivar uma segunda cartela', async () => {
    const f = desafioParticipacaoFixture();
    expect(f.desafio.limiteInscricoesPorUsuario).toBe(1);
    const primeira = await f.service.participar(7, 42);
    const segunda = await f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'segunda' });
    await preencher(f, segunda.id);
    expect(primeira.inscricao).toMatchObject({ numero: 1, nome: 'Palpite 1' });
    expect(segunda).toMatchObject({ numero: 2, nome: 'Palpite 2', status: 'RASCUNHO', valorInscricao: '0.00' });
    await expect(f.service.participar(7, 42, segunda.id)).rejects.toMatchObject({ response: { code: 'LIMITE_INSCRICOES_USUARIO_ATINGIDO' } });
    expect(f.state.movimentos).toHaveLength(1);
    expect(await f.service.participar(7, 42)).toEqual(primeira);
  });

  it.each(['FREE', 'PAGO'] as const)('%s efetiva duas cartelas distintas e retry nunca cobra novamente', async tipoAcesso => {
    const f = desafioParticipacaoFixture();
    Object.assign(f.desafio, { tipoAcesso, limiteInscricoesPorUsuario: 2, valorInscricao: new Prisma.Decimal(tipoAcesso === 'FREE' ? 0 : 2) });
    const primeira = await f.service.participar(7, 42);
    const segunda = await f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'segunda' });
    expect(f.state.movimentos).toHaveLength(tipoAcesso === 'FREE' ? 0 : 1);
    await expect(f.service.participar(7, 42, segunda.id)).rejects.toMatchObject({ response: { code: 'PALPITES_INCOMPLETOS' } });
    await preencher(f, segunda.id);
    const confirmado = await f.service.participar(7, 42, segunda.id);
    expect(confirmado.inscricao).toMatchObject({ numero: 2, status: 'ATIVA' });
    expect(f.state.palpites.filter(p => p.usuarioId === 42 && p.desafioPartidaId === 1)
      .map(p => [p.inscricaoId, p.palpite])).toEqual([[primeira.inscricao.id, 'CASA'], [segunda.id, 'FORA']]);
    f.desafio.status = 'ENCERRADO'; jest.setSystemTime(f.desafio.dataFim);
    expect(await f.service.participar(7, 42, segunda.id)).toEqual(confirmado);
    expect((await f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'segunda' })).id).toBe(segunda.id);
    expect(f.state.movimentos).toHaveLength(tipoAcesso === 'FREE' ? 0 : 2);
    expect(f.state.carteiras[0].saldoDisponivel.toFixed(2)).toBe(tipoAcesso === 'FREE' ? '10.00' : '6.00');
    expect(new Set(f.state.movimentos.map(m => m.referenciaId)).size).toBe(f.state.movimentos.length);
  });

  it('saldo insuficiente na segunda entrada preserva rascunho e primeira participacao', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.limiteInscricoesPorUsuario = 2;
    await f.service.participar(7, 42);
    const segunda = await f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'segunda' });
    await preencher(f, segunda.id); f.state.carteiras[0].saldoDisponivel = new Prisma.Decimal(0);
    await expect(f.service.participar(7, 42, segunda.id)).rejects.toMatchObject({ response: { code: 'SALDO_INSUFICIENTE' } });
    expect(f.state.inscricoes.find(i => i.id === segunda.id).status).toBe('RASCUNHO');
    expect(f.state.movimentos).toHaveLength(1);
  });

  it('retry concorrente da criacao usa a mesma sequencia; chaves distintas nao colidem', async () => {
    const f = desafioParticipacaoFixture();
    const repetidas = await Promise.all(Array.from({ length: 5 }, () => f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'mesma' })));
    expect(new Set(repetidas.map(i => i.id)).size).toBe(1);
    const distintas = await Promise.all(['a', 'b', 'c'].map(chaveIdempotencia => f.desafios.criarCartela(7, 42, { chaveIdempotencia })));
    expect(distintas.map(i => i.numero)).toEqual([3, 4, 5]);
    expect(f.state.movimentos).toEqual([]);
  });

  it('duas cartelas concorrentes disputam o limite sem cobrar a perdedora', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.limiteInscricoesPorUsuario = 2;
    await f.service.participar(7, 42);
    const cartelas = await Promise.all(['a', 'b'].map(chaveIdempotencia => f.desafios.criarCartela(7, 42, { chaveIdempotencia })));
    for (const i of cartelas) await preencher(f, i.id);
    const resultados = await Promise.allSettled(cartelas.map(i => f.service.participar(7, 42, i.id)));
    expect(resultados.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((resultados.find(r => r.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ response: { code: 'LIMITE_INSCRICOES_USUARIO_ATINGIDO' } });
    expect(f.state.inscricoes.filter(i => i.usuarioId === 42 && i.status === 'ATIVA')).toHaveLength(2);
    expect(f.state.movimentos).toHaveLength(2);
  });

  it('retry simultaneo de confirmacao da mesma cartela cobra exatamente uma vez', async () => {
    const f = desafioParticipacaoFixture(); f.desafio.limiteInscricoesPorUsuario = 2;
    const segunda = await f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'segunda' }); await preencher(f, segunda.id);
    const resultados = await Promise.all(Array.from({ length: 5 }, () => f.service.participar(7, 42, segunda.id)));
    expect(resultados.every(r => r.inscricao.id === segunda.id)).toBe(true);
    expect(f.state.movimentos).toHaveLength(1);
  });

  it('isola dono/desafio e bloqueia somente a partida fechada de cada cartela', async () => {
    const f = desafioParticipacaoFixture();
    const segunda = await f.desafios.criarCartela(7, 42, { chaveIdempotencia: 'segunda' }); await preencher(f, segunda.id);
    await expect(f.desafios.salvarPalpite(7, 1, 43, { inscricaoId: segunda.id, palpite: 'CASA' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.participar(7, 43, segunda.id)).rejects.toBeInstanceOf(NotFoundException);
    f.state.inscricoes.push({ ...f.state.inscricoes[0], id: 999, desafioId: 8 });
    await expect(f.desafios.salvarPalpite(7, 1, 42, { inscricaoId: 999, palpite: 'CASA' })).rejects.toBeInstanceOf(NotFoundException);
    jest.setSystemTime(f.state.partidas[0].dataInicio);
    for (const inscricaoId of [7042, segunda.id]) {
      await expect(f.desafios.salvarPalpite(7, 1, 42, { inscricaoId, palpite: 'EMPATE' })).rejects.toBeInstanceOf(ConflictException);
      await expect(f.desafios.salvarPalpite(7, 2, 42, { inscricaoId, palpite: 'EMPATE' })).resolves.toMatchObject({ palpite: 'EMPATE' });
    }
    expect(f.state.palpites.filter(p => p.usuarioId === 42 && p.desafioPartidaId === 1).map(p => p.palpite)).toEqual(['CASA', 'FORA']);
  });

  it('apura e ranqueia duas inscricoes do mesmo usuario separadamente, com empate compartilhado', async () => {
    const f = desafioApuracaoFixture(); jest.setSystemTime(new Date('2030-10-01T15:00:00Z'));
    f.state.inscricoes.push({ ...f.state.inscricoes[0], id: 4, sequencia: 2 });
    f.state.palpites.push({ ...f.state.palpites[0], id: 4, inscricaoId: 4, palpite: 'FORA' });
    await f.service.apurar(7);
    const ranking = (await f.ranking.consultar(7, { pagina: 1, limite: 20 })).ranking;
    expect(ranking.filter(r => r.participante.idUsuario === 1).map(r => [r.inscricaoId, r.nome, r.pontos, r.posicao]))
      .toEqual([[1, 'Palpite 1', 1, 1], [4, 'Palpite 2', 0, 2]]);
    expect(ranking.map(r => r.posicao)).toEqual([1, 2, 2, 2]);
    expect(f.state.palpites.filter(p => p.usuarioId === 1).map(p => [p.inscricaoId, Number(p.pontos), p.apurado]))
      .toEqual([[1, 1, true], [4, 0, true]]);
  });
});
