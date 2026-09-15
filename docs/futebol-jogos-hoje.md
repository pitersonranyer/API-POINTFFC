# Consulta pública de jogos do dia

`GET /futebol/jogos/hoje`

Rota pública no `FutebolQueryModule`, sem autenticação. Fluxo:
`FutebolJogosController → FutebolQueryService → Prisma → MySQL`.
O módulo de leitura não registra FootballDataClient nem FutebolSyncService.
O GET não consulta football-data.org, não executa sync e não escreve no banco.

## Dia e intervalo

O serviço captura `Date.now()` uma única vez. `futebolDayInterval` determina o dia
local com `Intl.DateTimeFormat`, usando a zona IANA `America/Sao_Paulo`.
Resolve separadamente o primeiro instante UTC desse dia e do dia local seguinte.
Não depende do timezone do processo, não fixa UTC-03 e não pressupõe que todo dia
tenha 24 horas. A busca dos limites pela data local também trata meias-noites
inexistentes e dias históricos de 23/25 horas devido ao horário de verão.

Para o dia local 15/09/2026:

```text
inicioUtc = 2026-09-15T03:00:00.000Z (inclusivo)
fimUtc    = 2026-09-16T03:00:00.000Z (exclusivo)
```

## Consulta

Uma chamada `futebolPartida.findMany`, sem consultas por partida:

```ts
where: {
  dataHoraUtc: { gte: inicioUtc, lt: fimUtc },
  competicao: { ativa: true },
},
orderBy: [
  { dataHoraUtc: 'asc' },
  { competicaoId: 'asc' },
  { id: 'asc' },
]
```

Não há lista fixa de códigos, filtro de temporada nem filtro de status. Entram
todas as partidas desse intervalo em competições cadastradas como ativas,
incluindo adiadas, suspensas, canceladas, finalizadas e statuses desconhecidos.
O select reutiliza `gameSelect`, acrescido da relação competição com id, codigo,
nome e emblemaUrl. Prisma resolve as relações; não há consultas adicionais em loop.

O mapper existente `mapGame` continua montando a partida. Aliases persistidos são
retornados normalmente. Cartola é preservado no contexto BSA e exposto como null
nas competições internacionais, inclusive se houver valor indevido na linha do time.
Estádio/local não é adicionado: não existe no modelo/DTO atual.

## Contrato

```json
{
  "data": "2026-09-15",
  "timezone": "America/Sao_Paulo",
  "total": 0,
  "jogos": []
}
```

`data` é o dia local; `dataHoraUtc` das partidas continua em UTC. Sem partidas,
retorna HTTP 200 com lista vazia. Cada jogo mantém todos os campos de
`FutebolJogoResponseDto` e acrescenta `competicao`.

O exemplo completo com uma partida está em
[`test/fixtures/futebol-jogos-hoje.response.json`](../test/fixtures/futebol-jogos-hoje.response.json).
O teste HTTP compara a resposta inteira com esse JSON. São dados sintéticos de
teste, não uma consulta de partidas reais de produção.

## Indexação — recomendação, não implementada

O schema e as migrations versionadas têm PK em ID, unique em EXTERNAL_ID,
índice (COMPETICAO_ID, TEMPORADA, RODADA) e índices nos IDs dos times.
Não há índice iniciado por DATA_HORA_UTC. Não foi consultado o catálogo físico
de índices de produção; índices adicionados fora das migrations não são conhecidos.

O filtro mantém DATA_HORA_UTC intacto: não usa DATE(), CONVERT_TZ() ou outra função
SQL nessa coluna. Assim fica apto a aproveitar índice por intervalo quando existir.
Sem índice de data adequado, o volume de linhas examinado pode crescer com o
histórico, mesmo que só um dia seja retornado.

Recomendação para uma entrega futura: avaliar índice composto
**(DATA_HORA_UTC, COMPETICAO_ID, ID)** e confirmar o plano com EXPLAIN e volume
representativo. Ele acompanha o filtro de intervalo e a ordenação determinística.
Nenhum índice, schema ou migration foi alterado nesta entrega.

## Validação

Testes HTTP com Prisma em memória cobrem limites inclusivo/exclusivo, virada de
dia, múltiplas competições e temporadas, competição inativa, desempates, todos os
statuses, resposta vazia, aliases, Cartola BSA/internacional, contrato completo e
ausência de chamadas ao provider/sync. Testes do conversor cobrem ano novo, ano
bissexto e transições históricas de horário de verão.

Frontend, scheduler, sync football-data e lógica de rodadaReferencia não foram
alterados. Não houve commit, deploy ou sync real.
