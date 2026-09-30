# Desafio: fluxo administrativo simplificado

O modulo existente agora permite: dados basicos → pesquisa por periodo → selecao de partidas → publicacao.
Nao ha migration nem alteracao no frontend. As colunas e os dados ja publicados sao preservados.

## Pesquisa

`GET /admin/desafios/fixtures?dataInicial=2026-10-01&dataFinal=2026-10-07`

JWT e PLATFORM_ADMIN ativo continuam obrigatorios. Ambas as datas usam `YYYY-MM-DD`,
sao inclusivas em UTC, com janela de 1 a 7 dias. Datas invalidas/invertidas ou janela
maior retornam 400 antes de consumir o provider. Os filtros antigos `date/from/to/league/team/season`
deixam de fazer parte deste endpoint. Os atalhos de calendario pertencem ao frontend.
Os filtros nao sao persistidos no Desafio.

A resposta continua sendo um array de `DesafioFixture`:

```json
[
  {
    "fixtureId": 123,
    "leagueId": 2013,
    "leagueNome": "Campeonato Brasileiro Serie A",
    "dataHoraInicio": "2026-10-03T19:00:00.000Z",
    "mandanteId": 1,
    "mandanteNome": "Mandante",
    "mandanteLogo": null,
    "visitanteId": 2,
    "visitanteNome": "Visitante",
    "visitanteLogo": null,
    "statusInterno": "AGENDADA",
    "horarioConfirmado": true
  }
]
```

Elegibilidade: AGENDADA, horario confirmado e kickoff futuro. A resposta inclui tambem
partidas inelegiveis para o frontend indicar a situacao. Ordenacao: kickoff, competicao, ID.
IDs duplicados sao eliminados. Escudos ausentes/invalidos sao null.

Competicoes seguem `FUTEBOL_COMPETICOES`: BSA (Brasileirao), CL (Champions League),
PL (Premier League), PD (La Liga), SA (Serie A italiana), BL1 (Bundesliga), FL1 (Ligue 1),
PPL (Primeira Liga), DED (Eredivisie) e ELC (Championship).

Uma chamada agregada a `/v4/matches?dateFrom=...&dateTo=...&competitions=...`, sem
temporada e sem consultar cada competicao separadamente. O fim enviado ao provider
e o dia seguinte, pois `dateTo` e exclusivo. Ha filtragem local de competicoes/intervalo.
Cache em memoria por instancia de 30 segundos (ate 100 intervalos), compartilhando
consultas simultaneas iguais. Erros nao viram cache de listas vazias. Mantida a fila do
cliente com espacamento de 6,5 segundos e timeout de 15 segundos por chamada.

Referencias oficiais: [lista agregada e filtros](https://www.football-data.org/documentation/quickstart)
e [intervalo e status de partidas](https://docs.football-data.org/general/v4/match.html).

## Criacao, composicao e datas

`POST /admin/desafios` aceita nome, descricao opcional, tipoAcesso, valorInscricao e
limiteParticipantes opcional, sem exigir datas. As quatro datas antigas continuam
aceitas como opcionais/depreciadas para compatibilidade de payloads; na criacao,
se enviadas, devem formar um periodo valido. PATCH de datas recalcula a composicao.

Em RASCUNHO, adicionar/remover partidas recalcula as datas na mesma transacao,
sob o lock existente de DESAFIO. Reordenar muda somente a exibicao. Competicoes
diferentes podem compor o mesmo Desafio. Nenhuma partida e rejeitada por ficar
fora de um periodo digitado anteriormente.

- `inicioInscricao`: provisorio no rascunho; igual a `publicadoEm` na publicacao.
- `fimInscricao` e `dataInicio`: menor kickoff oficial selecionado.
- `dataFim`: ultimo kickoff + 3 horas, referencia operacional, sem encerrar apuracao.
- Sem partidas: datas provisorias validas para as colunas NOT NULL, status RASCUNHO;
  publicar continua proibido. As datas sao substituidas quando houver composicao.

## Publicacao e ciclo

`POST /admin/desafios/:id/publicar` exige partidas, reconsulta os IDs oficiais sem cache
de pesquisa (lotes de ate 50), valida identidade/estado/horario e atualiza snapshots.
Composicao alterada durante a consulta aborta a publicacao. As validacoes de futuro
sao repetidas sob lock e depois das escritas; falhas desfazem a transacao.

Publicacao grava ABERTO e abre inscricoes imediatamente. No primeiro kickoff,
as respostas publicas/administrativas derivam EM_ANDAMENTO de ABERTO + dataInicio,
sem esperar cron nem criar statusInscricao. Filtros administrativos acompanham esse
estado derivado. A participacao existente ja bloqueia `agora >= fimInscricao/dataInicio`
e partidas iniciadas, inclusive antes/depois do debito. O status persistido continua
sendo atualizado pela apuracao existente; ENCERRADO depende das partidas resolvidas
(finalizadas/anuladas), nunca apenas de dataFim.

A listagem/detalhe publicos mantem ABERTO/EM_ANDAMENTO visiveis apos dataFim enquanto
aguardam apuracao. Palpites preservam seus bloqueios existentes (estado, kickoff
individual e dataFim); a nova visibilidade nao reabre palpites. FREE/PAGO, carteira,
PIX, requisitos de participacao, 1/X/2, pontuacao, ranking, empates e anulacoes permanecem.

Rotas de adicionar/remover/reordenar/publicar e formatos de suas respostas permanecem.
Reconsulte o detalhe administrativo para obter as datas recalculadas apos mudar partidas.
