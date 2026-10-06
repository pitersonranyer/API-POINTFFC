# Sumário Fantasy — primeira etapa da POC

`GET /fantasy/partidas/:fixtureId/sumario` é público temporariamente. Aceita ID composto de dígitos, inteiro positivo representável com segurança em JavaScript. Entrada inválida retorna 400 antes de consultar o provider.

Integração stateless: uma consulta a `/fixtures?id=...`, seguida de uma consulta a `/fixtures/events?fixture=...`. Não há cache, retry, persistência ou dependência de Prisma. A chave opcional `API_FOOTBALL_KEY` é obtida somente pelo `ConfigService`. Timeout de 15 segundos por requisição, incluindo leitura do corpo; redirects são rejeitados.

## Contrato

`SumarioPartida`, definido em `fantasy.types.ts`, contém:

- `partida`: `idExterno`, `campeonato`, `rodada` numérica ou null, `fase` com o rótulo original da rodada, `status` interno, `data`, `estadio`, `mandante`, `visitante`, `placar`.
- Equipes: `idExterno`, `nome`, `logo`. Participantes: `idExterno`, `nome`; participante ausente é null.
- `eventos`: `tipo`, `tempo` (`minuto`, `acrescimo`, `exibicao`), `equipe`, `comentarios`, `origem` (`tipo`, `detalhe`). Origem é informação diagnóstica; o consumidor utiliza `tipo` normalizado.
- Gols: `jogador`, `assistencia`, `placarAposEvento` (`mandante`, `visitante`).
- Substituições: `jogadorSai`, `jogadorEntra`, sem campo de assistência.
- Demais eventos: `jogador`, sem alteração do placar.

O placar do cabeçalho vem do fixture; o placar progressivo começa em 0 × 0 e considera somente os gols reconhecidos. Os eventos são ordenados por minuto e acréscimo, mantendo a ordem original em empates. `90+2'` permanece separado de 92 minutos.

## Mapeamentos

| Provedor | POINT FFC |
|---|---|
| Goal / Normal Goal | GOL |
| Card / Yellow Card | CARTAO_AMARELO |
| subst / qualquer detalhe | SUBSTITUICAO |
| Var / Goal cancelled | VAR_GOL_ANULADO |
| Demais combinações | DESCONHECIDO |

Eventos desconhecidos preservam jogador, equipe, comentários e origem sem quebrar o sumário. Novos detalhes de gol não são considerados gols válidos automaticamente, evitando contar penalidades perdidas. Expandir esses mapeamentos exige validar suas semânticas com o provedor.

Status internos: AGENDADA, A_DEFINIR, EM_ANDAMENTO, INTERVALO, ENCERRADA, ADIADA, CANCELADA, INTERROMPIDA, ABANDONADA, RESULTADO_ADMINISTRATIVO e DESCONHECIDO.

## Erros

| Situação | HTTP |
|---|---|
| ID inválido | 400 |
| Fixture vazio | 404 |
| Chave ausente ou HTTP 429 | 503 |
| Timeout | 504 |
| Rede, HTTP externo não bem-sucedido, JSON/envelope inválido, errors não vazio ou dados essenciais inválidos | 502 |

Mensagens públicas são fixas e não reproduzem erros, corpos ou credenciais do provider. Não há logs de credenciais nem logs de mensagens externas.

## Validação e limites

Testes automatizados em `fantasy.spec.ts` e `api-football.client.spec.ts` usam mocks e não consomem cota. As consultas manuais abaixo foram feitas pelo serviço isolado, sem iniciar o bootstrap ou executar migrations, com duas requisições por fixture. As verificações compararam os eventos normalizados com os retornados pelo client, inclusive entrada/saída nas substituições e ordenação estável.

| Fixture | Resultado da validação real |
|---|---|
| 1180729 — Botafogo 2 × 1 São Paulo | Cabeçalho da rodada 38, 3 gols e 10 substituições. Savarino aos 37 (assistência de Igor Jesus): 1 × 0; William aos 63: 1 × 1; Gregore aos 90+2: 2 × 1. Substituições expõem saída/entrada sem assistência. |
| 1180730 — Palmeiras 0 × 1 Fluminense | 7 cartões amarelos com comentários originais, 8 substituições e VAR de gol anulado de Vanderlan aos 54, sem incremento do placar. Gol de Serna aos 37, com assistência de Nonato: 0 × 1. Acréscimos recebidos em ordem 90+3, 90+7, 90+4 e entregues em ordem 90+3, 90+4, 90+7. |

Antes da exposição pública real, revisar proteção da rota e controle de consumo externo.

## Estatísticas — segunda etapa da POC

`GET /fantasy/partidas/:fixtureId/estatisticas` usa o mesmo client, configuração, timeout, tratamento de erros e validação de ID do Sumário. A rota permanece pública temporariamente. A implementação é stateless, sem banco, cache ou retry.

### Fonte e identificação das equipes

Consulta `/fixtures?id=:fixtureId` e depois `/fixtures/statistics?fixture=:fixtureId` em `https://v3.football.api-sports.io`. Statistics contém o ID de cada equipe, mas não identifica sua condição de mandante/visitante. A consulta adicional de fixture é necessária para determinar essa condição com segurança; reutiliza `ApiFootballClient.fixture`, sem chamar o Sumário nem buscar eventos. São duas requisições por acesso, independentemente da ordem do array de estatísticas.

Os IDs associam as estatísticas às equipes. Nome e logo vêm do fixture, mantendo consistência com o cabeçalho do Sumário. Equipes estranhas ao fixture, IDs duplicados e estatísticas conhecidas duplicadas retornam 502, evitando atribuição ambígua.

### Contrato POINT FFC

```json
{
  "partida": { "idExterno": 1180729 },
  "mandante": {
    "idExterno": 120,
    "nome": "Botafogo",
    "logo": "https://media.api-sports.io/football/teams/120.png",
    "estatisticas": {
      "finalizacoesNoGol": 8,
      "finalizacoesFora": 8,
      "finalizacoes": 17,
      "finalizacoesBloqueadas": 1,
      "finalizacoesDentroArea": 10,
      "finalizacoesForaArea": 7,
      "faltas": 8,
      "escanteios": 3,
      "impedimentos": 1,
      "posseBola": 46,
      "cartoesAmarelos": null,
      "cartoesVermelhos": null,
      "defesasGoleiro": 0,
      "passes": 504,
      "passesCertos": 466,
      "precisaoPasses": 92,
      "golsEsperados": 1.88,
      "golsEvitados": 0.5
    }
  },
  "visitante": {
    "idExterno": 126,
    "nome": "Sao Paulo",
    "logo": "https://media.api-sports.io/football/teams/126.png",
    "estatisticas": {
      "finalizacoesNoGol": 1,
      "finalizacoesFora": 3,
      "finalizacoes": 5,
      "finalizacoesBloqueadas": 1,
      "finalizacoesDentroArea": 1,
      "finalizacoesForaArea": 4,
      "faltas": 3,
      "escanteios": 0,
      "impedimentos": 0,
      "posseBola": 54,
      "cartoesAmarelos": null,
      "cartoesVermelhos": null,
      "defesasGoleiro": 5,
      "passes": 600,
      "passesCertos": 544,
      "precisaoPasses": 91,
      "golsEsperados": 0.32,
      "golsEvitados": 0.5
    }
  }
}
```

Os 18 campos de `estatisticas` estão sempre presentes para cada equipe e são `number | null`. Não são calculadas métricas derivadas.

| API-Football | POINT FFC | Valor |
|---|---|---|
| Shots on Goal | finalizacoesNoGol | Inteiro não negativo |
| Shots off Goal | finalizacoesFora | Inteiro não negativo |
| Total Shots | finalizacoes | Inteiro não negativo |
| Blocked Shots | finalizacoesBloqueadas | Inteiro não negativo |
| Shots insidebox | finalizacoesDentroArea | Inteiro não negativo |
| Shots outsidebox | finalizacoesForaArea | Inteiro não negativo |
| Fouls | faltas | Inteiro não negativo |
| Corner Kicks | escanteios | Inteiro não negativo |
| Offsides | impedimentos | Inteiro não negativo |
| Ball Possession | posseBola | Percentual de 0 a 100 |
| Yellow Cards | cartoesAmarelos | Inteiro não negativo |
| Red Cards | cartoesVermelhos | Inteiro não negativo |
| Goalkeeper Saves | defesasGoleiro | Inteiro não negativo |
| Total passes | passes | Inteiro não negativo |
| Passes accurate | passesCertos | Inteiro não negativo |
| Passes % | precisaoPasses | Percentual de 0 a 100 |
| expected_goals | golsEsperados | Decimal não negativo |
| goals_prevented | golsEvitados | Decimal, admite sinal |

### Valores ausentes, inválidos e desconhecidos

Zero informado permanece `0`. Null informado ou campo ausente permanece `null`; não se infere zero. Fixture existente com resposta `[]`, equipe ausente ou lista vazia de estatísticas retorna 200 com os campos correspondentes null. Isso não afirma que a equipe realizou zero ações.

Percentuais como `"46%"` viram `46`, na escala 0–100; também são aceitos números e strings numéricas sem `%`. Decimais textuais como `"1.88"` viram números. Contagens exigem inteiros não negativos representáveis com segurança em JavaScript. A conversão exige o valor completo: string vazia, texto parcial, valores não finitos e percentuais fora da escala não viram zero e retornam 502.

Estatísticas de tipo desconhecido com estrutura válida são ignoradas por uma lista explícita de campos conhecidos, sem expor nomes do provider nem criar chaves dinâmicas no contrato. Esta etapa escolhe a opção de ignorar controladamente permitida pelo escopo, em vez de adicionar uma área diagnóstica sem utilidade imediata para a comparação. Isso mantém o contrato estável; adicionar novos tipos exige evoluir o mapper. O payload bruto não é repassado ao frontend.

### Erros e limitações

400 para ID inválido antes de qualquer requisição; 404 para fixture inexistente; 503 para chave ausente ou HTTP 429; 504 para timeout; 502 para rede, HTTP externo não bem-sucedido, JSON/envelope inválido, `errors` não vazio, estrutura inválida, valor conhecido inválido ou associação ambígua. As mensagens reutilizam o tratamento sanitizado existente. Ausência de estatísticas de um fixture existente é uma resposta 200 com null, não um erro externo.

A disponibilidade depende do provider. Não se completam cartões ausentes usando eventos, nem se calculam métricas a partir de outras estatísticas. A consulta real retornou cartões null, que foram preservados. Revisar proteção e consumo externo antes da exposição pública real. Formação, jogadores, pré-jogo e Fantasy Engine não fazem parte desta etapa.

### Validação realizada

`fantasy-estatisticas.spec.ts` cobre os 18 campos, associação por ID com array invertido, percentuais, zero, null, decimais, campos desconhecidos, valores inválidos, respostas parciais/vazias e ID inválido sem provider. `api-football.client.spec.ts` verifica o tratamento externo existente para events e statistics, além da estrutura de statistics. Os testes do Sumário permanecem passando.

107 testes do módulo Fantasy passaram, assim como lint, typecheck e build. A inspeção inicial consultou somente statistics; após implementar, foi feita uma validação real isolada pelo serviço com o fixture 1180729, sem bootstrap ou migrations. Os seis valores conhecidos do Botafogo coincidiram: 8, 8, 17, 1, 10 e 7. Foram confirmados IDs 120/126, posse 46%, defesas 0, cartões null e xG 1.88. Nenhuma divergência encontrada.
