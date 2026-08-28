# Integração Cartola — Frontend Fantasy Point

## Visão geral

O frontend não deve chamar diretamente a API da Globo. Todos os dados do Cartola devem ser consumidos pelo backend do Fantasy Point.

Fluxo:

```text
Frontend Fantasy Point
  → Backend Fantasy Point (/cartola/*)
  → API pública do Cartola
  → cache compartilhado do backend
  → resposta para o frontend
```

Em desenvolvimento, a URL padrão do backend é:

```text
http://localhost:3001
```

Os endpoints `/cartola/*` são públicos e não exigem Firebase ID Token nem JWT Fantasy Point.

## Endpoint recomendado para o Dashboard

### `GET /cartola/dashboard`

Este é o endpoint principal para montar a visão inicial do Dashboard. Ele agrega mercado, rodada, partidas e clubes usando os mesmos caches dos endpoints individuais.

Exemplo de resposta:

```json
{
  "mercado": {
    "rodada_atual": 25,
    "status_mercado": 1,
    "bola_rolando": false,
    "game_over": false,
    "temporada": 2026,
    "nome_rodada": "Rodada 25",
    "rodada_final": 38,
    "fechamento": {}
  },
  "rodada": 25,
  "mercadoAberto": true,
  "bolaRolando": false,
  "partidas": [
    {
      "partida_id": 123,
      "clube_casa_id": 1,
      "clube_visitante_id": 2,
      "partida_data": "2026-08-29 18:30:00",
      "timestamp": 1788039000,
      "local": "Estádio",
      "placar_oficial_mandante": null,
      "placar_oficial_visitante": null,
      "periodo_tr": "",
      "status_cronometro_tr": "",
      "inicio_cronometro_tr": "",
      "valida": true
    }
  ],
  "clubes": {
    "1": {
      "id": 1,
      "nome": "Clube",
      "abreviacao": "CLU"
    }
  }
}
```

Os objetos retornados pela Globo podem conter campos adicionais. O frontend deve ignorar campos desconhecidos em vez de rejeitar a resposta.

## Estado do mercado

O frontend trabalha somente com dois estados:

```ts
const textoMercado = dashboard.mercadoAberto
  ? 'Mercado Aberto'
  : 'Mercado Fechado';
```

O backend calcula `mercadoAberto` da seguinte forma:

- `status_mercado === 1`: Mercado Aberto.
- Qualquer outro valor: Mercado Fechado.

Não criar estados como `RODADA_EM_ANDAMENTO`, `ENTRE_JOGOS` ou `RODADA_ENCERRADA` para representar o mercado.

## Bola rolando

`bolaRolando` é independente de `mercadoAberto`:

- `mercadoAberto: false` e `bolaRolando: true`: existem jogos ao vivo.
- `mercadoAberto: false` e `bolaRolando: false`: não há jogo ao vivo naquele momento.
- `mercadoAberto: true` e `bolaRolando: false`: escalações ainda podem ser realizadas.

Exemplo de apresentação:

```ts
const exibirAoVivo = !dashboard.mercadoAberto && dashboard.bolaRolando;
```

Não inferir jogo ao vivo somente pelo horário de uma partida. Use `bolaRolando` como indicador global fornecido pelo Cartola.

## Endpoints disponíveis

### `GET /cartola/mercado/status`

Retorna a resposta original do estado do mercado Cartola.

Campos principais:

```ts
interface CartolaMarketStatus {
  rodada_atual: number;
  status_mercado: number;
  fechamento?: Record<string, unknown>;
  bola_rolando: boolean;
  game_over?: boolean;
  temporada?: number;
  nome_rodada?: string;
  rodada_final?: number;
  [campoAdicional: string]: unknown;
}
```

### `GET /cartola/atletas/mercado`

Retorna atletas e informações disponíveis no mercado. É indicado para telas de escalação e consultas de atletas.

Durante Mercado Fechado, o conteúdo pode permanecer em cache por mais tempo.

### `GET /cartola/atletas/pontuados`

Retorna atletas pontuados e suas parciais ou pontuações finais quando o mercado está fechado. Durante `bolaRolando: true`, o backend atualiza esse conteúdo com maior frequência.

Com o mercado aberto, este endpoint sem rodada retorna HTTP `400`. Nesse estado, utilize o endpoint com a rodada desejada:

```http
GET /cartola/atletas/pontuados/24
```

### `GET /cartola/atletas/pontuados/:rodada`

Retorna os atletas pontuados da rodada informada. Este é o formato que deve ser usado quando o mercado estiver aberto. A rodada deve ser um inteiro entre `1` e `38`.

Este endpoint pode responder `502` quando a Globo ainda não disponibilizou uma resposta válida e o backend não possui uma versão anterior no cache.

### `GET /cartola/clubes`

Retorna um objeto de clubes indexado pelo identificador do clube. Possui cache longo.

### `GET /cartola/partidas`

Retorna rodada, clubes e partidas da rodada atual:

```ts
interface CartolaMatchesResponse {
  rodada: number;
  clubes: Record<string, unknown>;
  partidas: CartolaMatch[];
  [campoAdicional: string]: unknown;
}

interface CartolaMatch {
  partida_id: number;
  clube_casa_id: number;
  clube_visitante_id: number;
  partida_data?: string;
  timestamp?: number;
  local?: string;
  placar_oficial_mandante?: number | null;
  placar_oficial_visitante?: number | null;
  periodo_tr?: string;
  status_cronometro_tr?: string;
  inicio_cronometro_tr?: string;
  valida?: boolean;
  [campoAdicional: string]: unknown;
}
```

### `GET /cartola/partidas/:rodada`

Retorna partidas de uma rodada específica.

Regras para `rodada`:

- Deve ser um número inteiro.
- Valor mínimo: `1`.
- Valor máximo: `38`.
- Um valor inválido retorna HTTP `400`.

Exemplo:

```http
GET /cartola/partidas/25
```

Rodadas anteriores possuem cache mais longo porque seus dados tendem a não mudar.

## Tipos sugeridos no frontend

```ts
export interface CartolaMarketStatus {
  rodada_atual: number;
  status_mercado: number;
  fechamento?: Record<string, unknown>;
  bola_rolando: boolean;
  game_over?: boolean;
  temporada?: number;
  nome_rodada?: string;
  rodada_final?: number;
  [key: string]: unknown;
}

export interface CartolaMatch {
  partida_id: number;
  clube_casa_id: number;
  clube_visitante_id: number;
  partida_data?: string;
  timestamp?: number;
  local?: string;
  placar_oficial_mandante?: number | null;
  placar_oficial_visitante?: number | null;
  periodo_tr?: string;
  status_cronometro_tr?: string;
  inicio_cronometro_tr?: string;
  valida?: boolean;
  [key: string]: unknown;
}

export interface CartolaDashboardResponse {
  mercado: CartolaMarketStatus;
  rodada: number;
  mercadoAberto: boolean;
  bolaRolando: boolean;
  partidas: CartolaMatch[];
  clubes: Record<string, unknown>;
}
```

## Exemplo de consumo

```ts
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export async function buscarDashboard(): Promise<CartolaDashboardResponse> {
  const response = await fetch(`${API_URL}/cartola/dashboard`);

  if (!response.ok) {
    throw new Error(`Falha ao carregar Dashboard: HTTP ${response.status}`);
  }

  return response.json() as Promise<CartolaDashboardResponse>;
}
```

Nenhum header de autenticação é necessário nesses endpoints.

## Cache e headers de resposta

O backend pode retornar:

```http
X-Cartola-Cache: hit
X-Cartola-Stale: false
```

Valores de `X-Cartola-Cache`:

- `miss`: o backend consultou a API externa e armazenou a resposta.
- `hit`: o backend respondeu usando o cache ainda válido.
- `stale`: a atualização externa falhou e o último dado conhecido foi utilizado.

`X-Cartola-Stale: true` informa que o payload é o último dado válido disponível. Normalmente o frontend pode continuar exibindo o conteúdo e, opcionalmente, mostrar um aviso discreto de atualização temporariamente indisponível.

Esses headers são informativos. O contrato JSON não é alterado por causa do cache.

## Tratamento de erros

O frontend deve tratar:

- `400 Bad Request`: rodada inválida ou rodada não informada para atletas pontuados com o mercado aberto.
- `502 Bad Gateway`: a Globo respondeu com erro ou conteúdo inválido, sem fallback disponível.
- `503 Service Unavailable`: timeout da API da Globo, sem fallback disponível.
- Outros erros `5xx`: falha inesperada do backend.

Com fallback disponível, o backend retorna HTTP `200`, o payload anterior e `X-Cartola-Stale: true`.

Sugestão de comportamento:

- Manter os dados anteriores já renderizados durante falhas temporárias.
- Exibir estado de carregamento somente na primeira consulta.
- Oferecer tentativa manual de atualização quando não houver dados.
- Não substituir falhas por placares, parciais ou estados inventados.

## Estratégia recomendada de atualização

O backend já controla a frequência de acesso à Globo. O frontend pode consultar os endpoints conforme a necessidade da interface sem tentar reproduzir todos os TTLs internos.

Para o Dashboard:

- Fazer uma chamada inicial a `/cartola/dashboard`.
- Com `bolaRolando: true`, atualizar a tela aproximadamente a cada 15–30 segundos.
- Fora de jogos ao vivo, atualizar aproximadamente a cada 30–60 segundos ou quando o usuário voltar para a tela.
- Para parciais ao vivo com mercado fechado, consultar `/cartola/atletas/pontuados`.
- Com mercado aberto, consultar `/cartola/atletas/pontuados/:rodada` informando a rodada desejada.
- Cancelar polling quando a aba ou componente não estiver ativo, quando possível.

Mesmo com vários usuários, o backend deduplica atualizações simultâneas por chave e compartilha o cache dentro da instância.

## Swagger

Com o backend iniciado:

```text
http://localhost:3001/docs
```

Todos os endpoints estão agrupados pela tag `cartola` e podem ser executados diretamente pela interface do Swagger.

## Fora deste contrato

Esta integração não fornece:

- odds ou patrocinadores;
- IA ou LLM;
- xG, xGA ou probabilidade de SG;
- Times, Ligas ou Inscrições do Fantasy Point;
- cálculo próprio de pontuação das ligas.

Dados de odds e futuras análises do Mago devem permanecer conceitualmente separados dos dados esportivos fornecidos pelo Cartola.
