# Integração frontend — busca de times Cartola

Este documento descreve o contrato entre o frontend do Fantasy Point e os endpoints públicos usados para localizar times do Cartola.

## Visão geral

O frontend deve chamar somente o backend do Fantasy Point:

```text
Frontend
  → Fantasy Point Backend (/cartola/times*)
  → API pública do Cartola
```

Não acesse a API da Globo diretamente pelo navegador. Estes endpoints são públicos nesta etapa e não exigem Firebase ID Token nem JWT do Fantasy Point.

Em desenvolvimento, a URL padrão do backend é:

```text
http://localhost:3001
```

## Tipos sugeridos

Os payloads do Cartola podem ganhar campos novos. Por isso, os tipos devem aceitar propriedades adicionais.

```ts
export interface CartolaTimePesquisa {
  time_id: number;
  nome: string;
  nome_cartola?: string;
  slug?: string;
  url_escudo_png?: string;
  url_escudo_svg?: string;
  patrimonio?: number;
  [key: string]: unknown;
}

export interface CartolaTimeResumo extends CartolaTimePesquisa {
  timeId: number;
  cartoleiro?: string;
  escudo?: string;
}

export interface CartolaBuscaErro {
  timeId: number;
  tipo: 'timeout' | 'api_indisponivel';
}

export interface CartolaBuscaPorIdsResponse {
  solicitados: number;
  encontrados: number;
  naoEncontrados: number;
  times: CartolaTimeResumo[];
  idsNaoEncontrados: number[];
  erros: CartolaBuscaErro[];
}
```

## Buscar times pelo nome

```http
GET /cartola/times?nome=Meu%20Time
```

Regras:

- `nome` é obrigatório;
- espaços nas extremidades são removidos pelo backend;
- mínimo de 2 caracteres;
- nomes não são únicos;
- o resultado é sempre uma lista.

Exemplo com `fetch`:

```ts
const API_URL = 'http://localhost:3001';

export async function buscarTimesPorNome(nome: string): Promise<CartolaTimePesquisa[]> {
  const termo = nome.trim();
  if (termo.length < 2) return [];

  const response = await fetch(
    `${API_URL}/cartola/times?nome=${encodeURIComponent(termo)}`,
  );

  if (!response.ok) {
    throw new Error(`Falha ao buscar times: HTTP ${response.status}`);
  }

  return response.json() as Promise<CartolaTimePesquisa[]>;
}
```

Resposta HTTP 200:

```json
[
  {
    "time_id": 50062955,
    "nome": "Meu Time",
    "nome_cartola": "Nome do cartoleiro",
    "slug": "meu-time",
    "url_escudo_png": "https://..."
  }
]
```

Para campos de busca, aplique debounce de aproximadamente 300 a 500 ms e cancele a requisição anterior quando o texto mudar.

## Buscar um time pelo ID

```http
GET /cartola/times/{timeId}
```

Exemplo:

```http
GET /cartola/times/50062955
```

Regras:

- o ID deve ser inteiro;
- o ID deve ser maior que zero;
- ID inválido retorna HTTP 400;
- time inexistente retorna HTTP 404.

Exemplo com `fetch`:

```ts
export async function buscarTimePorId(timeId: number): Promise<unknown | null> {
  const response = await fetch(`${API_URL}/cartola/times/${timeId}`);

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Falha ao buscar o time: HTTP ${response.status}`);
  }

  return response.json();
}
```

Esse endpoint preserva o payload detalhado retornado pelo Cartola. Atualmente os metadados principais ficam em `time`, mas o frontend deve tolerar campos adicionais:

```json
{
  "time": {
    "time_id": 50062955,
    "nome": "Meu Time",
    "nome_cartola": "Nome do cartoleiro",
    "slug": "meu-time",
    "url_escudo_png": "https://..."
  },
  "atletas": [],
  "patrimonio": 100.25
}
```

## Buscar vários times por ID

```http
POST /cartola/times/buscar-por-ids
Content-Type: application/json
```

O formato recomendado para código novo é `number[]`:

```json
{
  "timeIds": [50062955, 123456, 999999999]
}
```

Também é aceito o formato textual:

```json
{
  "timeIds": "50062955;123456;999999999"
}
```

Normalização realizada pelo backend:

- separa a string por `;`;
- remove espaços e posições vazias;
- rejeita valores não inteiros ou menores que 1;
- remove IDs duplicados;
- preserva a ordem original;
- aceita no máximo 50 IDs únicos.

Exemplo com `fetch`:

```ts
export async function buscarTimesPorIds(
  timeIds: number[],
): Promise<CartolaBuscaPorIdsResponse> {
  const response = await fetch(`${API_URL}/cartola/times/buscar-por-ids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeIds }),
  });

  if (!response.ok) {
    throw new Error(`Falha na busca em lote: HTTP ${response.status}`);
  }

  return response.json() as Promise<CartolaBuscaPorIdsResponse>;
}
```

Resposta HTTP 200 com resultado parcial:

```json
{
  "solicitados": 3,
  "encontrados": 1,
  "naoEncontrados": 1,
  "times": [
    {
      "time_id": 50062955,
      "timeId": 50062955,
      "nome": "Meu Time",
      "nome_cartola": "Nome do cartoleiro",
      "cartoleiro": "Nome do cartoleiro",
      "url_escudo_png": "https://...",
      "escudo": "https://..."
    }
  ],
  "idsNaoEncontrados": [999999999],
  "erros": [
    {
      "timeId": 123456,
      "tipo": "timeout"
    }
  ]
}
```

Uma falha individual não derruba o lote. O frontend deve processar separadamente:

- `times`: resultados encontrados;
- `idsNaoEncontrados`: IDs que não existem no Cartola;
- `erros`: IDs que não puderam ser consultados por timeout ou indisponibilidade externa.

## Tratamento de erros

| Status | Significado | Tratamento sugerido |
| --- | --- | --- |
| `200` | Consulta concluída, inclusive lote parcial | Renderizar resultados e avisos parciais |
| `400` | Parâmetro ou body inválido | Mostrar a mensagem de validação |
| `404` | Time consultado por ID não encontrado | Informar que o time não foi localizado |
| `502` | API pública do Cartola respondeu com erro | Oferecer nova tentativa |
| `503` | Timeout ao consultar o Cartola | Informar indisponibilidade temporária |

Erros de validação do Nest normalmente seguem este formato:

```json
{
  "message": ["nome deve ter no mínimo 2 caracteres"],
  "error": "Bad Request",
  "statusCode": 400
}
```

## Cache

O cache é controlado pelo backend:

- busca por ID: 10 minutos;
- busca por nome: 2 minutos;
- fallback stale quando existe uma resposta anterior e a API externa falha.

As respostas expõem os headers:

```text
X-Cartola-Cache: hit | miss | stale
X-Cartola-Stale: true | false
```

O frontend normalmente não precisa alterar seu comportamento com base nesses headers. Se `X-Cartola-Stale` for `true`, pode exibir discretamente que os dados vieram do cache devido à indisponibilidade temporária do Cartola.

## Fluxo sugerido para a tela Adicionar Time

1. Usuário escolhe busca por nome ou informa um ID.
2. Frontend valida o mínimo necessário antes da chamada.
3. Busca por nome apresenta todos os resultados, mostrando nome, cartoleiro e escudo.
4. Usuário seleciona um resultado pelo `time_id`.
5. Frontend mantém o `time_id` selecionado para a futura etapa de associação.

Esta integração apenas localiza times. Ela não cria vínculo com usuário, não persiste favoritos e não comprova propriedade do time.

## Testes no Swagger

Com o backend em execução, acesse:

```text
http://localhost:3001/docs
```

Na tag `cartola`, use **Try it out**:

```text
GET /cartola/times?nome=Flamengo
GET /cartola/times/50062955
```

Para o lote:

```json
{
  "timeIds": "50062955;50062955;999999999"
}
```

O resultado deve contabilizar dois IDs solicitados após remover a duplicidade, um encontrado e um não encontrado.
