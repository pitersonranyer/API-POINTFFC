import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../src/cartola/cartola.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TimeSnapshotsService } from '../src/time-snapshots/time-snapshots.service';
import { SincronizacaoPontuacoesService } from '../src/ligas-competicoes/sincronizacao-pontuacoes.service';
import { RoundProcessingService } from '../src/round-processing/round-processing.service';
import { simulateRound } from '../src/round-processing/round-simulation';

function fixture() {
  const team = {
    id: 1, timeId: 123, capitaoId: null as number | null, reservaLuxoId: null as number | null,
    time: { nomeTime: 'chute de ouro C01 (sintetico)' },
    escalacao: [
      { atletaId: 10, nome: 'Britez', clubeId: 1, posicaoId: 3, titular: true, reserva: false, capitao: false },
      { atletaId: 20, nome: 'Millan', clubeId: 2, posicaoId: 3, titular: false, reserva: true, capitao: false },
    ],
    pontuacao: { pontuacao: new Prisma.Decimal(0) } as { pontuacao: Prisma.Decimal } | null,
    substituicoes: [] as Array<{ atletaSaiuId: number; atletaEntrouId: number; posicaoId: number }>,
  };
  const round = {
    temporada: 2026, rodada: 29, status: 'CONSOLIDADA', consolidadoEm: new Date('2026-01-01'),
    timesPrevistos: [123], lockToken: null as string | null, lockAte: null as Date | null,
    pontuados: { rodada: 29, total_atletas: 2, atletas: {
      '11': { pontuacao: 2, entrou_em_campo: true, clube_id: 1 },
      '20': { pontuacao: 7.2, entrou_em_campo: true, clube_id: 2 },
    } as Record<string, { pontuacao: number; entrou_em_campo?: boolean; clube_id?: number }> },
    partidas: { rodada: 29, clubes: {}, partidas: [
      { partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2, valida: true, periodo_tr: 'F', timestamp: 1000 },
    ] },
  };
  const forbidden = jest.fn(() => { throw new Error('Efeito colateral proibido'); });
  const model = (reads: Record<string, unknown>) => new Proxy(reads, { get: (target, key: string) => key in target ? target[key] : forbidden });
  const tx = {
    rodadaProcessamento: model({ findUnique: jest.fn(async () => round) }),
    timeRodada: model({ findMany: jest.fn(async () => [team]) }),
    $executeRaw: forbidden, $queryRaw: forbidden,
  };
  const prisma = { ...tx, $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
  const external = new Proxy({}, { get: () => forbidden });
  const service = new RoundProcessingService(prisma as unknown as PrismaService, external as CartolaService,
    external as TimeSnapshotsService, {} as ConfigService, external as SincronizacaoPontuacoesService);
  const run = () => service.simularReconsolidacao(29, 2026);
  return { round, team, service, run, forbidden, prisma, tx };
}

describe('Simulacao historica sem gravacao', () => {
  it('fora da janela usa Britez/Millan sintetico, identifica delta 7,20 e repete sem efeitos colaterais', async () => {
    const f = fixture(); const before = JSON.stringify({ round: f.round, team: f.team });
    const result = await f.run();
    expect(result).toMatchObject({ temporada: 2026, rodada: 29, statusRodada: 'CONSOLIDADA', totalTimes: 1,
      consistentes: 0, divergentes: 1, pendentesDeDados: 0, naoVerificaveis: 0 });
    expect(result.times[0]).toMatchObject({ classificacao: 'DIVERGENTE', pontuacaoPersistida: 0,
      pontuacaoRecalculada: 7.2, diferenca: 7.2, jogadoresParticiparam: 1,
      substituicoesEsperadas: [{ atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 3, reservaLuxo: false, herdouCapitao: false }] });
    expect(await f.run()).toEqual(result);
    expect(JSON.stringify({ round: f.round, team: f.team })).toBe(before);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(f.tx.timeRodada.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { temporada: 2026, rodada: 29 } }));
    expect(JSON.stringify(result)).not.toContain('pontuados');
  });

  it('rodada pendente suficiente pode ser consistente sem alterar status', async () => {
    const f = fixture(); f.round.status = 'AGUARDANDO_CONSOLIDACAO';
    f.team.pontuacao!.pontuacao = new Prisma.Decimal(7.2);
    f.team.substituicoes.push({ atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 3 });
    expect((await f.run()).times[0].classificacao).toBe('CONSISTENTE');
    expect(f.round.status).toBe('AGUARDANDO_CONSOLIDACAO');
  });

  it('capitao substituido transfere bracadeira e multiplica por 1,5', async () => {
    const f = fixture(); f.team.capitaoId = 10; f.team.escalacao[0].capitao = true;
    expect((await f.run()).times[0]).toMatchObject({ capitaoEfetivoId: 20, pontuacaoRecalculada: 10.8,
      substituicoesEsperadas: [{ herdouCapitao: true }] });
  });

  it('luxo admite negativo superior e detecta troca divergente com total igual', async () => {
    const f = fixture(); f.team.reservaLuxoId = 20;
    f.round.pontuados.atletas['10'] = { pontuacao: -2, entrou_em_campo: true, clube_id: 1 };
    f.round.pontuados.total_atletas++;
    f.round.pontuados.atletas['20'].pontuacao = -1;
    f.team.pontuacao!.pontuacao = new Prisma.Decimal(-1);
    expect((await f.run()).times[0]).toMatchObject({ classificacao: 'DIVERGENTE', diferenca: 0,
      motivo: 'Substituicoes divergentes', substituicoesEsperadas: [{ reservaLuxo: true }] });
  });

  it.each(['sem-completude', 'jogo-em-andamento', 'sem-cobertura', 'participacao-desconhecida', 'sem-pontuacao', 'concorrente'])('dados insuficientes: %s', async (condition) => {
    const f = fixture();
    if (condition === 'sem-completude') delete (f.round.pontuados as { total_atletas?: number }).total_atletas;
    if (condition === 'jogo-em-andamento') f.round.partidas.partidas[0].periodo_tr = '2T';
    if (condition === 'sem-cobertura') f.round.pontuados.atletas['11'].clube_id = 2;
    if (condition === 'participacao-desconhecida') delete f.round.pontuados.atletas['20'].entrou_em_campo;
    if (condition === 'sem-pontuacao') f.team.pontuacao = null;
    if (condition === 'concorrente') { f.round.lockToken = 'worker'; f.round.lockAte = new Date(Date.now() + 120000); }
    const result = (await f.run()).times[0];
    expect(result.classificacao).toBe('PENDENTE_DE_DADOS');
    expect(result.motivo).toBeTruthy();
    expect(result.diferenca).toBeNull();
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('snapshot inconsistente nao e verificavel', async () => {
    const f = fixture(); f.team.escalacao.push({ ...f.team.escalacao[0] });
    expect((await f.run()).times[0].classificacao).toBe('NÃO_VERIFICÁVEL');
  });

  it('envelope de outra rodada nao e verificavel', async () => {
    const f = fixture(); f.round.pontuados.rodada = 28;
    expect((await f.run()).times[0].classificacao).toBe('NÃO_VERIFICÁVEL');
  });

  it('envelope com contagem incompleta permanece pendente', async () => {
    const f = fixture(); f.round.pontuados.total_atletas++;
    expect((await f.run()).times[0].classificacao).toBe('PENDENTE_DE_DADOS');
  });

  it('informa snapshots esperados ausentes e nao apresenta diagnostico definitivo', async () => {
    const f = fixture(); f.round.timesPrevistos.push(999);
    expect(await f.run()).toMatchObject({ timesSemSnapshot: 1, diagnosticoDefinitivo: false });
    f.round.lockToken = 'worker'; f.round.lockAte = new Date(Date.now() + 120000);
    expect(await f.run()).toMatchObject({ processamentoEmAndamento: true, diagnosticoDefinitivo: false });
  });

  it('substituicao persistida invalida nao e verificavel', async () => {
    const f = fixture(); f.team.substituicoes.push({ atletaSaiuId: 10, atletaEntrouId: 99, posicaoId: 3 });
    expect((await f.run()).times[0].classificacao).toBe('NÃO_VERIFICÁVEL');
  });

  it('zero nao significa ausencia', async () => {
    const f = fixture(); f.round.pontuados.atletas['10'] = { pontuacao: 0, entrou_em_campo: true, clube_id: 1 };
    f.round.pontuados.total_atletas++;
    expect((await f.run()).times[0]).toMatchObject({ classificacao: 'CONSISTENTE', jogadoresParticiparam: 1, substituicoesEsperadas: [] });
  });

  it('ordem e IDs tecnicos das substituicoes nao geram divergencias', () => {
    const f = fixture();
    f.team.escalacao.push(
      { atletaId: 40, nome: 'Titular', clubeId: 1, posicaoId: 4, titular: true, reserva: false, capitao: false },
      { atletaId: 50, nome: 'Reserva', clubeId: 2, posicaoId: 4, titular: false, reserva: true, capitao: false },
    );
    f.round.pontuados.atletas['50'] = { pontuacao: 1, entrou_em_campo: true, clube_id: 2 };
    f.round.pontuados.total_atletas++;
    f.team.pontuacao!.pontuacao = new Prisma.Decimal(8.2);
    f.team.substituicoes = [{ atletaSaiuId: 40, atletaEntrouId: 50, posicaoId: 4 }, { atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 3 }];
    const result = simulateRound(f.round as unknown as Parameters<typeof simulateRound>[0],
      [f.team] as unknown as Parameters<typeof simulateRound>[1]);
    expect(result.times[0].classificacao).toBe('CONSISTENTE');
  });

  it('rodada inexistente retorna 404', async () => {
    const f = fixture(); (f.tx.rodadaProcessamento.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(f.run()).rejects.toMatchObject({ status: 404 });
  });

  it('falha de leitura propaga erro, sem fabricar pontuacao zero', async () => {
    const f = fixture(); (f.tx.timeRodada.findMany as jest.Mock).mockRejectedValue(new Error('Falha de leitura'));
    await expect(f.run()).rejects.toThrow('Falha de leitura');
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each([[0, 2026], [39, 2026], [29, 0]])('valida rodada %s e temporada %s', async (round, season) => {
    const f = fixture(); await expect(f.service.simularReconsolidacao(round, season)).rejects.toMatchObject({ status: 400 });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
