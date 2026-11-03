import { ConfigService } from '@nestjs/config';
import { ApiFutebolV2Client } from './api-futebol-v2.client';
import { mapEstatisticas, mapFormacao, mapPreJogo, mapSumario } from './api-futebol-v2.mapper';
import { finalizada, futura, eventos, lances, estatisticas } from '../../test/helpers/api-futebol-v2.fixture';
import { FantasyService } from './fantasy.service';
import { FantasyController } from './fantasy.controller';

describe('Contratos da Central — API Futebol V2', () => {
  it('preserva contexto e separa prováveis de confirmadas', () => {
    const p = mapPreJogo(finalizada);
    expect(p.partida).toMatchObject({ fornecedor: 'API_FUTEBOL_V2', idExterno: 321, status: 'ENCERRADA', placar: { mandante: 2, visitante: 1 } });
    expect(p.escalacoes.mandante.confirmada?.titulares[0].posicao).toBe('Atacante');
    expect(p.escalacoes.mandante.provavel?.titulares[0].posicao).toBe('Meio-campo');
  });
  it('expõe indisponibilidade de escalação futura e preserva desfalques', () => {
    const p = mapPreJogo(futura);
    expect(p.escalacoesDisponiveis).toBe(false);
    expect(p.escalacoes.mandante.confirmada).toBeNull();
    expect(p.desfalques.map(a => a.situacao)).toEqual(['suspenso', 'duvida']);
    expect(mapFormacao(futura).mandante).toMatchObject({ disponivel: false, titulares: [], reservas: [] });
  });
  it('ordena por período, mantém intervalo, assistências e acréscimos divergentes', () => {
    const p = mapSumario(finalizada, eventos, lances);
    expect(p.eventos.map(e => e.tipo)).toEqual(['SUBSTITUICAO', 'GOL', 'GOL']);
    expect(p.eventos[0]).toMatchObject({ tempo: { minuto: null }, jogadorSai: { idExterno: 97 }, jogadorEntra: { idExterno: 100 } });
    expect(p.eventos[1].assistencia?.idExterno).toBe(560);
    expect(p.eventos[2]).toMatchObject({ assistencia: null, tempo: { minuto: 45, acrescimo: 7 } });
    expect(p.narrativa[0]).toMatchObject({ acrescimo: 6, periodo: 'segundo-tempo', periodoOriginal: 'second-half', equipe: null });
  });
  it('preserva grid e função sem inventar posição cadastral; prefere confirmada', () => {
    const p = mapFormacao(finalizada).mandante;
    expect(p.tipoEscalacao).toBe('CONFIRMADA');
    expect(p.titulares[0]).toMatchObject({ grid: '4:3', coordenada: { linha: 4, coluna: 3 }, posicaoCadastral: null, funcaoPartida: { codigo: 'ATA' } });
    const d = structuredClone(finalizada);
    (d.escalacoes.mandante as unknown as { confirmada: null }).confirmada = null;
    expect(mapFormacao(d).mandante).toMatchObject({ tipoEscalacao: 'PROVAVEL', titulares: [{ grid: null, coordenada: null }] });
  });
  it('preserva null, zero e métricas individuais; exclui gols por tempo e xG ambíguo', () => {
    const p = mapEstatisticas(finalizada, estatisticas);
    expect(p.mandante.estatisticas).toMatchObject({ posseBola: 67, passes: 782, passesCertos: null, golsEsperados: 1.86 });
    expect(p.mandante.porTempo.primeiroTempo).toEqual({ escanteios: 2, cartoes: 0 });
    expect(JSON.stringify(p)).not.toContain('golsEsperadosTotal');
    expect(p.mandante.porTempo.segundoTempo).not.toHaveProperty('gols');
    expect(p.mandante.atletas[0]).toMatchObject({ estatisticas: { golsEsperados: null }, goleiroEstatisticas: { defesas: 4, finalizacoesSofridas: null } });
    expect(p.visitante.disponivel).toBe(false);
  });
  it('rejeita equipe estatística divergente e jogador duplicado', () => {
    expect(() => mapEstatisticas(finalizada, { ...estatisticas, mandante: { time: { id: 17, nome: 'Mirassol' } } })).toThrow();
    const d = structuredClone(finalizada);
    d.escalacoes.mandante.confirmada.titulares.push(d.escalacoes.mandante.confirmada.titulares[0]);
    expect(() => mapFormacao(d)).toThrow();
  });
  it('aceita vermelhos, comissão técnica e VAR sem inferir gol anulado', () => {
    const p = mapSumario(finalizada, { eventos: { mandante: {
      cartoes: { vermelho: [{ periodo: 'segundo-tempo', minuto: 10, atleta: null, comissao_tecnica: { id: 238, nome: 'Marcão' } }] },
      var: [{ periodo: 'segundo-tempo', minuto: 11, descricao: 'Revisão' }],
    } } }, { lances: [] });
    expect(p.eventos[0]).toMatchObject({ tipo: 'CARTAO_VERMELHO', jogador: null, comissaoTecnica: { idExterno: 238 } });
    expect(p.eventos[1]).toMatchObject({ tipo: 'VAR', comentarios: 'Revisão' });
  });
  it('não publica atributos novos ou xG total nos dados individuais', () => {
    const stats = structuredClone(estatisticas);
    Object.assign(stats.mandante.atletas[0], { gols_esperados_total: 3.17, futuro_campo: { interno: true } });
    expect(mapEstatisticas(finalizada, stats).mandante.atletas[0].estatisticas).not.toHaveProperty('golsEsperadosTotal');
  });
});

describe('Cliente V2 — cache, quota e erros isolados', () => {
  const originalFetch = global.fetch;
  let mock: jest.Mock, client: ApiFutebolV2Client;
  const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => ({ ok: status === 200, status, headers: new Headers(headers), json: async () => ({ data }) });
  beforeEach(() => {
    mock = jest.fn(); global.fetch = mock;
    client = new ApiFutebolV2Client(new ConfigService({ API_FUTEBOL_V2_KEY: 'test-only', API_FUTEBOL_V2_TTL_PRE_MS: 1000, API_FUTEBOL_V2_TTL_LIVE_MS: 1000, API_FUTEBOL_V2_TTL_FINAL_MS: 2000 }));
  });
  afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });
  it('envia Bearer, rejeita redirects e coalesce consultas simultâneas entre abas', async () => {
    mock.mockResolvedValue(response(finalizada));
    const controller = new FantasyController(new FantasyService(client));
    const [pre, form] = await Promise.all([controller.preJogo('321'), controller.formacao('321')]);
    expect(pre.partida.idExterno).toBe(321); expect(form.partida.idExterno).toBe(321);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith('https://api.api-futebol.com.br/v2/partidas/321', expect.objectContaining({ headers: { Authorization: 'Bearer test-only', Accept: 'application/json' }, redirect: 'error' }));
    pre.partida.mandante.nome = 'alterado';
    expect((await controller.preJogo('321')).partida.mandante.nome).toBe('Fluminense');
  });
  it.each([401, 403, 429, 500, 503])('sanitiza erro HTTP %s e não faz fallback', async status => {
    mock.mockResolvedValue(response({ secret: 'não retornar' }, status));
    await expect(client.detalhe(321)).rejects.toMatchObject({ status: 503 });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('não consulta fornecedor sem chave ou com ID inválido', async () => {
    const service = new FantasyService(client);
    await expect(service.preJogo('1180729x')).rejects.toMatchObject({ status: 400 });
    const empty = new ApiFutebolV2Client(new ConfigService());
    await expect(empty.detalhe(321)).rejects.toMatchObject({ status: 503 });
    expect(mock).not.toHaveBeenCalled();
  });
  it('não cacheia falhas e valida identidade/envelope', async () => {
    mock.mockResolvedValueOnce(response({ id: 340 })).mockResolvedValueOnce(response(finalizada));
    await expect(client.detalhe(321)).rejects.toMatchObject({ status: 502 });
    await expect(client.detalhe(321)).resolves.toHaveProperty('id', 321);
  });
  it('sanitiza falhas de rede e JSON inválido e libera a fila', async () => {
    mock.mockRejectedValueOnce(new Error('test-only')).mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error('test-only'); } }).mockResolvedValueOnce(response(finalizada));
    await expect(client.detalhe(321)).rejects.toMatchObject({ status: 502 });
    await expect(client.detalhe(321)).rejects.toMatchObject({ status: 502 });
    await expect(client.detalhe(321)).resolves.toHaveProperty('id', 321);
  });
  it('respeita quota no metadata quando headers não estão presentes', async () => {
    mock.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: finalizada, metadata: { requisicoes: { restantes: 0, reseta_em: Math.ceil(Date.now() / 1000) + 120 } } }) });
    await client.detalhe(321);
    await expect(client.lances(321)).rejects.toMatchObject({ status: 503 });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('respeita quota esgotada e reset mesmo entre endpoints', async () => {
    jest.useFakeTimers();
    const reset = Math.ceil((Date.now() + 120000) / 1000);
    mock.mockResolvedValue(response(finalizada, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    await client.detalhe(321);
    await expect(client.eventos(321)).rejects.toMatchObject({ status: 503 });
    expect(mock).toHaveBeenCalledTimes(1);
    jest.setSystemTime(reset * 1000 + 1);
    mock.mockResolvedValue(response(eventos));
    await expect(client.eventos(321)).resolves.toHaveProperty('eventos');
  });
  it('respeita Retry-After e permite cache válido durante bloqueio', async () => {
    mock.mockResolvedValueOnce(response(finalizada)).mockResolvedValueOnce(response({}, 429, { 'retry-after': '120' }));
    await client.detalhe(321);
    await expect(client.eventos(321)).rejects.toMatchObject({ status: 503 });
    await expect(client.lances(321)).rejects.toMatchObject({ status: 503 });
    await expect(client.detalhe(321)).resolves.toHaveProperty('id', 321);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it.each(['finalizado', 'andamento', 'agendado'])('expira cache conforme status %s', async status => {
    jest.useFakeTimers();
    mock.mockResolvedValue(response({ ...finalizada, status }));
    await client.detalhe(321);
    jest.setSystemTime(Date.now() + 1500);
    await client.detalhe(321);
    expect(mock).toHaveBeenCalledTimes(status === 'finalizado' ? 1 : 2);
  });
  it('timeout cobre corpo da resposta e não expõe erros externos', async () => {
    jest.useFakeTimers();
    mock.mockImplementation(async (_url, options) => ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('segredo')))) }));
    const work = expect(client.detalhe(321)).rejects.toMatchObject({ status: 504 });
    await jest.advanceTimersByTimeAsync(15001);
    await work;
  });
  it('reutiliza detalhe, eventos e lances no sumário e estatísticas entre acessos', async () => {
    mock.mockImplementation(async url => response(String(url).endsWith('/eventos') ? eventos : String(url).endsWith('/lances') ? lances : String(url).endsWith('/estatisticas') ? estatisticas : finalizada));
    const service = new FantasyService(client);
    await service.sumario('321'); await service.estatisticas('321'); await service.sumario('321');
    expect(mock).toHaveBeenCalledTimes(4);
  });
});
