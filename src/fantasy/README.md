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

Antes da exposição pública real, revisar proteção da rota e controle de consumo externo. Nenhuma outra etapa da POC está implementada.
