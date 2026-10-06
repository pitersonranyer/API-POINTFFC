// Metadados temporários internos: nunca são anexados à resposta HTTP.
export type CategoriaFormacao = 'JSON_INVALIDO' | 'ENVELOPE_INVALIDO' | 'PROVIDER_ERRORS'
  | 'FIXTURE_INVALIDO' | 'EQUIPE_INVALIDA' | 'JOGADOR_INVALIDO' | 'ATRIBUTO_INVALIDO'
  | 'ID_DUPLICADO' | 'ERRO_DESCONHECIDO';
export type EtapaFormacao = 'fixture' | 'lineups' | 'mapper';

const categorias = new WeakMap<object, CategoriaFormacao>();

export function marcarDiagnostico<T extends Error>(error: T, categoria: CategoriaFormacao): T {
  categorias.set(error, categoria);
  return error;
}

export function categoriaDiagnostico(error: unknown): CategoriaFormacao {
  return error !== null && typeof error === 'object'
    ? categorias.get(error) ?? 'ERRO_DESCONHECIDO' : 'ERRO_DESCONHECIDO';
}
