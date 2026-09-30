import { DesafioStatus } from '@prisma/client';

// Sem partidas, datas provisorias apenas satisfazem as colunas NOT NULL do rascunho.
// dataFim e uma referencia de calendario, nunca uma ordem para encerrar a apuracao.
export function periodoDasPartidas(partidas: ReadonlyArray<{ dataInicio: Date }>, agora = new Date()) {
  const horarios = partidas.map(p => p.dataInicio.getTime());
  const primeiro = horarios.length ? Math.min(...horarios) : agora.getTime() + 1000;
  const ultimo = horarios.length ? Math.max(...horarios) : primeiro;
  return {
    inicioInscricao: new Date(Math.min(agora.getTime(), primeiro - 1000)),
    fimInscricao: new Date(primeiro), dataInicio: new Date(primeiro),
    dataFim: new Date(ultimo + 3 * 60 * 60 * 1000),
  };
}

export function statusDoDesafio(desafio: { status: DesafioStatus; dataInicio: Date }, agora = new Date()): DesafioStatus {
  return desafio.status === 'ABERTO' && agora >= desafio.dataInicio ? 'EM_ANDAMENTO' : desafio.status;
}
