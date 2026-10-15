import { BadRequestException } from '@nestjs/common';
import { FORMATION_COUNTS, validateSelection } from '../src/point-fantasy/lineups/lineup.rules';
import { assertLineupEditable } from '../src/point-fantasy/lineups/lineup.service';
import { completeLineup } from './point-fantasy-lineup.fixture';

describe('Fantasy lineups rules', () => {
  it.each(Object.keys(FORMATION_COUNTS))('formacao completa %s inclui 11 jogadores, tecnico e 5 reservas', formation => {
    const { selection, athletes } = completeLineup(formation);
    expect(selection.titulares).toHaveLength(11);
    expect(selection.reservas).toHaveLength(5);
    expect(validateSelection(selection, athletes)).toEqual({ completa: true, pendencias: [] });
  });
  it.each(Object.keys(FORMATION_COUNTS))('rascunho incompleto %s identifica pendencias', formacao => {
    expect(validateSelection({ formacao, titulares: [], reservas: [], tecnico: null, capitaoAtletaId: null, reservaMagoAtletaId: null }, []).completa).toBe(false);
  });
  it.each(['__proto__', '4-2-4', ''])('rejeita formacao %s', formacao => {
    const f = completeLineup(); f.selection.formacao = formacao;
    expect(() => validateSelection(f.selection, f.athletes)).toThrow(BadRequestException);
  });
  it.each(['capitaoReserva', 'capitaoTecnico', 'magoTitular', 'magoTecnico', 'titularTecnico', 'reservaTecnico', 'tecnicoJogador', 'duplicado', 'reservaTitular', 'externo', 'excesso'])('rejeita %s', scenario => {
    const { selection: s, athletes } = completeLineup();
    if (scenario === 'capitaoReserva') s.capitaoAtletaId = s.reservas[0];
    if (scenario === 'capitaoTecnico') s.capitaoAtletaId = s.tecnico;
    if (scenario === 'magoTitular') s.reservaMagoAtletaId = s.titulares[0];
    if (scenario === 'magoTecnico') s.reservaMagoAtletaId = s.tecnico;
    if (scenario === 'titularTecnico') { s.titulares[1] = s.tecnico!; s.tecnico = null; }
    if (scenario === 'reservaTecnico') { s.reservas[1] = s.tecnico!; s.tecnico = null; }
    if (scenario === 'tecnicoJogador') { s.tecnico = s.titulares.pop()!; }
    if (scenario === 'duplicado') s.titulares[1] = s.titulares[0];
    if (scenario === 'reservaTitular') s.reservas[1] = s.titulares[1];
    if (scenario === 'externo') s.titulares[1] = 99999;
    if (scenario === 'excesso') { const extra = { ...athletes[0], id: 999 }; athletes.push(extra); s.titulares.push(extra.id); }
    expect(() => validateSelection(s, athletes)).toThrow(BadRequestException);
  });
  it('sem laterais: quinto reserva e outro zagueiro', () => {
    const f = completeLineup('3-5-2');
    f.athletes.find(a => a.id === f.selection.reservas[4])!.posicaoId = 2;
    expect(() => validateSelection(f.selection, f.athletes)).toThrow('reservas invalida');
  });
  it.each([[3,2,true],[2,2,true],[1,2,false],[3,3,true],[2,3,false],[1,1,true]])('menor titular %s e reserva %s: %s', (starterCategory, reserveCategory, allowed) => {
    const f = completeLineup();
    f.athletes[0].categoriaId = starterCategory;
    f.athletes.find(a => a.id === f.selection.reservas[0])!.categoriaId = reserveCategory;
    if (allowed) expect(validateSelection(f.selection, f.athletes).completa).toBe(true);
    else expect(() => validateSelection(f.selection, f.athletes)).toThrow('Categoria do reserva');
  });
  it('usa menor categoria de todos os titulares da mesma posicao', () => {
    const f = completeLineup();
    f.athletes.find(a => a.posicaoId === 4)!.categoriaId = 1;
    expect(() => validateSelection(f.selection, f.athletes)).toThrow('Categoria do reserva');
  });
  it('reserva pode preceder titulares em rascunho, com validacao pendente', () => {
    const f = completeLineup(); f.selection.titulares = []; f.selection.capitaoAtletaId = null;
    const result = validateSelection(f.selection, f.athletes);
    expect(result.completa).toBe(false);
    expect(result.pendencias.some(p => p.includes('aguarda titulares'))).toBe(true);
  });
  it('nenhum teto de POINTCOINS', () => {
    const f = completeLineup(); f.athletes.forEach(a => { a.pointcoins = 30; if (a.posicaoId !== 6) a.categoriaId = 3; });
    expect(validateSelection(f.selection, f.athletes).completa).toBe(true);
  });
  const competition = () => ({ status: 'PUBLICADA', temporada: 2026, rodada: 31, inicioInscricao: new Date('2026-10-01Z'), fechamentoDefinitivoEm: null,
    catalogo: { status: 'CONGELADO', temporada: 2026, rodada: 31 }, partidas: [{ status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date('2026-10-17T21:00:00Z') }] }) as any;
  it('bloqueia no instante previsto, conservadoramente', () => {
    const c = competition();
    expect(() => assertLineupEditable(c, new Date('2026-10-17T20:59:59.999Z'))).not.toThrow();
    expect(() => assertLineupEditable(c, new Date('2026-10-17T21:00:00Z'))).toThrow();
  });
  it.each(['inicioReal', 'status', 'semPartidas', 'naoPublicada', 'naoCongelado', 'temporada', 'fechada', 'antesAbertura'])('bloqueia %s', reason => {
    const c = competition();
    if (reason === 'inicioReal') c.partidas[0].inicioReal = new Date('2026-10-15Z');
    if (reason === 'status') c.partidas[0].status = 'EM_ANDAMENTO';
    if (reason === 'semPartidas') c.partidas = [];
    if (reason === 'naoPublicada') c.status = 'RASCUNHO';
    if (reason === 'naoCongelado') c.catalogo.status = 'CAPTURADO';
    if (reason === 'temporada') c.catalogo.temporada = 2025;
    if (reason === 'fechada') c.fechamentoDefinitivoEm = new Date('2026-10-15Z');
    if (reason === 'antesAbertura') c.inicioInscricao = new Date('2026-10-16Z');
    expect(() => assertLineupEditable(c, new Date('2026-10-15T12:00:00Z'))).toThrow();
  });
});
