import { BadGatewayException, ConflictException, GatewayTimeoutException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FootballDataError } from '../src/futebol/football-data.normalizer';
import { desafioApuracaoFixture, resultadoOficial } from './helpers/desafio-apuracao.fixture';

const pagina = { pagina: 1, limite: 20 };

describe('Apuracao e ranking de Desafios', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2030-10-01T15:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it.each([[2, 0, 'CASA', 1], [1, 1, 'EMPATE', 2], [0, 2, 'FORA', 3]] as const)
  ('apura %s x %s (%s), atribui 1/0 e encerra', async (home, away, resultado, vencedor) => {
    const f = desafioApuracaoFixture(); f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(100, home, away)]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'ENCERRADO', partidasApuradas: 1, partidasPendentes: 0 });
    expect(f.state.partidas[0]).toMatchObject({ status: 'FINALIZADA', resultado, golsMandante: home, golsVisitante: away });
    expect(f.state.palpites.map(p => [p.usuarioId, Number(p.pontos), p.apurado])).toEqual([1, 2, 3].map(id => [id, id === vencedor ? 1 : 0, true]));
    expect((await f.ranking.consultar(7, pagina)).ranking[0]).toMatchObject({ participante: { idUsuario: vencedor }, pontos: 1, acertos: 1, posicao: 1 });
    expect(f.proibido).not.toHaveBeenCalled();
  });

  it('reexecucao nao acumula pontos e correcao oficial recalcula acertos/erros', async () => {
    const f = desafioApuracaoFixture();
    const primeira = await f.service.apurar(7); const ranking = await f.ranking.consultar(7, pagina);
    expect(await f.service.apurar(7)).toEqual(primeira);
    expect(await f.ranking.consultar(7, pagina)).toEqual(ranking);
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(100, 0, 2)]);
    await f.service.apurar(7);
    expect(f.state.palpites.map(p => Number(p.pontos))).toEqual([0, 0, 1]);
  });

  it.each(['CANCELLED', 'SUSPENDED', 'POSTPONED', 'AWARDED'])('anula %s removendo pontos anteriores e pontuacao maxima', async status => {
    const f = desafioApuracaoFixture(); await f.service.apurar(7);
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(100, 2, 0, status)]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'ENCERRADO', partidasAnuladas: 1, partidasApuradas: 0 });
    expect(f.state.partidas[0]).toMatchObject({ status: 'ANULADA', resultado: null, golsMandante: null, golsVisitante: null });
    expect(f.state.palpites.every(p => p.pontos === null && p.apurado === false)).toBe(true);
    const ranking = await f.ranking.consultar(7, pagina);
    expect(ranking).toMatchObject({ pontuacaoMaxima: 0, totalPartidasValidas: 0, totalPartidasApuradas: 0, totalPartidasAnuladas: 1 });
    expect(ranking.ranking.every(p => p.posicao === 1 && p.pontos === 0)).toBe(true);
  });

  it.each(['TIMED', 'IN_PLAY', 'PAUSED'])('nao apura partida pendente %s nem encerra por dataFim expirada', async status => {
    const f = desafioApuracaoFixture(); f.state.desafio.dataFim = new Date('2030-10-01T14:00:00Z');
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(100, 2, 0, status)]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'EM_ANDAMENTO', partidasPendentes: 1 });
    expect(f.state.palpites.every(p => p.pontos === null && !p.apurado)).toBe(true);
  });

  it('antes do inicio, partidas futuras preservam ABERTO', async () => {
    const f = desafioApuracaoFixture(); f.state.desafio.dataInicio = new Date('2030-10-02T12:00:00Z');
    f.api.buscarResultadosPorIds.mockResolvedValue([{ ...resultadoOficial(100, 0, 0, 'TIMED'), dataHoraInicio: '2030-10-02T12:00:00Z' }]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'ABERTO', partidasPendentes: 1 });
  });

  it('FINISHED sem placar seguro informa pendencia e pode resolver numa nova consulta', async () => {
    const f = desafioApuracaoFixture();
    f.api.buscarResultadosPorIds.mockResolvedValue([{ ...resultadoOficial(), statusApuracao: 'EM_ANDAMENTO', resultado: null,
      golsMandante: null, golsVisitante: null, pendencia: 'PLACAR_90_MINUTOS_INDISPONIVEL' }]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'EM_ANDAMENTO', partidasPendentes: 1,
      pendencias: [{ partidaId: 1, motivo: 'PLACAR_90_MINUTOS_INDISPONIVEL' }] });
    expect(f.state.palpites.every(p => !p.apurado)).toBe(true);
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial()]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'ENCERRADO', partidasApuradas: 1 });
  });

  it('encerra somente quando todas forem resolvidas; reabre EM_ANDAMENTO se fornecedor reagendar', async () => {
    const f = desafioApuracaoFixture();
    f.state.partidas.push({ ...f.state.partidas[0], id: 2, fixtureIdApiFootball: 101 });
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(), resultadoOficial(101, 0, 0, 'IN_PLAY')]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'EM_ANDAMENTO', partidasApuradas: 1, partidasPendentes: 1 });
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(), resultadoOficial(101, 0, 0, 'POSTPONED')]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'ENCERRADO', partidasApuradas: 1, partidasAnuladas: 1 });
    f.api.buscarResultadosPorIds.mockResolvedValue([resultadoOficial(), resultadoOficial(101, 0, 0, 'TIMED')]);
    expect(await f.service.apurar(7)).toMatchObject({ status: 'EM_ANDAMENTO', partidasPendentes: 1 });
  });

  it('ranking inclui apenas ATIVA, mesmo que nao tenha acertos/palpites', async () => {
    const f = desafioApuracaoFixture(); f.state.inscricoes = f.state.inscricoes.filter(i => i.usuarioId !== 1);
    f.state.inscricoes[0].status = 'CANCELADA';
    f.state.inscricoes.push({ usuarioId: 4, desafioId: 7, status: 'ATIVA', usuario: { idUsuario: 4, nome: 'Sem palpite', fotoUrl: null } });
    await f.service.apurar(7);
    const result = await f.ranking.consultar(7, pagina);
    expect(result.ranking.map(r => [r.participante.idUsuario, r.pontos, r.posicao])).toEqual([[3, 0, 1], [4, 0, 1]]);
    expect(f.tx.desafioInscricao.findMany).toHaveBeenCalledWith({ where: { desafioId: 7, status: 'ATIVA' },
      select: { usuarioId: true, usuario: { select: { idUsuario: true, nome: true, fotoUrl: true } } } });
  });

  it('posicoes 1,1,3,4,4 permanecem compartilhadas inclusive entre paginas', async () => {
    const f = desafioApuracaoFixture();
    f.state.partidas = Array.from({ length: 8 }, (_, n) => ({ ...f.state.partidas[0], id: n + 1, status: 'FINALIZADA', resultado: 'CASA', golsMandante: 1, golsVisitante: 0 }));
    f.state.inscricoes = [5, 4, 3, 2, 1].map(usuarioId => ({ usuarioId, desafioId: 7, status: 'ATIVA',
      usuario: { idUsuario: usuarioId, nome: `Nome ${usuarioId}`, fotoUrl: null } }));
    f.state.palpites = [8, 8, 7, 6, 6].flatMap((pontos, n) => Array.from({ length: pontos }, (_, partida) => ({
      usuarioId: n + 1, desafioId: 7, desafioPartidaId: partida + 1, apurado: true, pontos: new Prisma.Decimal(1),
    })));
    const result = await f.ranking.consultar(7, pagina);
    expect(result.ranking.map(r => [r.posicao, r.pontos, r.acertos])).toEqual([[1, 8, 8], [1, 8, 8], [3, 7, 7], [4, 6, 6], [4, 6, 6]]);
    expect(result.ranking.map(r => r.participante.idUsuario)).toEqual([1, 2, 3, 4, 5]);
    expect((await f.ranking.consultar(7, { pagina: 2, limite: 1 })).ranking[0].posicao).toBe(1);
    expect(f.prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });

  it('ignora pontos residuais em partidas pendentes/anuladas ou palpites nao apurados', async () => {
    const f = desafioApuracaoFixture();
    f.state.palpites.forEach(p => { p.pontos = new Prisma.Decimal(1); p.apurado = true; });
    f.state.partidas[0].status = 'ANULADA';
    expect((await f.ranking.consultar(7, pagina)).ranking.every(r => r.pontos === 0)).toBe(true);
    f.state.partidas[0].status = 'AGENDADA';
    expect((await f.ranking.consultar(7, pagina)).ranking.every(r => r.pontos === 0)).toBe(true);
    Object.assign(f.state.partidas[0], { status: 'FINALIZADA', resultado: 'CASA', golsMandante: 1, golsVisitante: 0 });
    f.state.palpites.forEach(p => { p.apurado = false; });
    expect((await f.ranking.consultar(7, pagina)).ranking.every(r => r.pontos === 0)).toBe(true);
  });

  it.each(['RASCUNHO', 'CANCELADO'])('recusa apuracao e ranking de %s', async status => {
    const f = desafioApuracaoFixture(); f.state.desafio.status = status;
    await expect(f.service.apurar(7)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.ranking.consultar(7, pagina)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.api.buscarResultadosPorIds).not.toHaveBeenCalled();
  });

  it('ranking encerrado continua publico apos dataFim; nao publicado permanece oculto', async () => {
    const f = desafioApuracaoFixture(); await f.service.apurar(7); jest.setSystemTime(new Date('2031-01-01'));
    await expect(f.ranking.consultar(7, pagina)).resolves.toMatchObject({ status: 'ENCERRADO' });
    f.state.desafio.publicadoEm = null;
    await expect(f.ranking.consultar(7, pagina)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('nao encerra Desafio vazio e retorna 404 para inexistente', async () => {
    const f = desafioApuracaoFixture(); f.state.partidas = [];
    await expect(f.service.apurar(7)).rejects.toBeInstanceOf(ConflictException);
    f.state.desafio = null;
    await expect(f.service.apurar(7)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('falhas externas, IDs ausentes e identidade divergente nao alteram o banco', async () => {
    const f = desafioApuracaoFixture();
    for (const [code, tipo] of [['TIMEOUT', GatewayTimeoutException], ['RATE_LIMIT', ServiceUnavailableException], ['NETWORK', BadGatewayException]] as const) {
      f.api.buscarResultadosPorIds.mockRejectedValueOnce(new FootballDataError('erro', code));
      await expect(f.service.apurar(7)).rejects.toBeInstanceOf(tipo);
    }
    f.api.buscarResultadosPorIds.mockResolvedValueOnce([]);
    await expect(f.service.apurar(7)).rejects.toBeInstanceOf(BadGatewayException);
    f.api.buscarResultadosPorIds.mockResolvedValueOnce([{ ...resultadoOficial(), mandanteId: 999 }]);
    await expect(f.service.apurar(7)).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.desafioPartida.update).not.toHaveBeenCalled();
  });

  it('rejeita snapshot alterado durante consulta e consulta fornecedor fora dos locks', async () => {
    const f = desafioApuracaoFixture();
    f.api.buscarResultadosPorIds.mockImplementationOnce(async () => {
      f.state.partidas[0].status = 'ANULADA'; return [resultadoOficial()];
    });
    await expect(f.service.apurar(7)).rejects.toBeInstanceOf(ConflictException);
    expect(f.api.buscarResultadosPorIds.mock.invocationCallOrder[0]).toBeLessThan(f.tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(f.tx.desafioPalpite.updateMany).not.toHaveBeenCalled();
  });

  it('rollback integral se gravacao de pontos/status falhar', async () => {
    const f = desafioApuracaoFixture(); f.tx.desafio.update.mockRejectedValueOnce(new Error('falha'));
    await expect(f.service.apurar(7)).rejects.toThrow('falha');
    expect(f.state.partidas[0].status).toBe('AGENDADA');
    expect(f.state.palpites.every(p => p.pontos === null && !p.apurado)).toBe(true);
    expect(f.state.desafio.status).toBe('ABERTO');
  });
});
