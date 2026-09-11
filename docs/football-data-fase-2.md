# Futebol — Fase 2: API pública de leitura local

## Contrato e arquitetura

Os endpoints públicos usam FutebolController → FutebolQueryService → PrismaService → MySQL.
FutebolQueryModule é importado por AppModule e não importa FutebolModule, FutebolSyncService ou FootballDataClient.
Nenhuma requisição destes endpoints chama football-data.org, inicia sincronização ou consome quota externa.
Não há cache, scheduler ou alterações em frontend, Cartola, autenticação, carteira/PIX.

| Método e rota | Comportamento |
| --- | --- |
| GET /futebol/competicoes | Competições ativas, ordenadas por código |
| GET /futebol/competicoes/:codigo/jogos | Jogos filtrados no MySQL; temporada atual por padrão |
| GET /futebol/competicoes/:codigo/rodadas/:rodada | Todos os jogos da rodada na temporada atual |
| GET /futebol/competicoes/:codigo/rodada-atual | Seleção determinística da rodada e seus jogos |

A consulta por código não é restrita a BSA. Não são cadastradas outras competições.
Somente a listagem de competições filtra ativa=true; consulta direta permite uma competição local inativa conhecida.

Filtros de jogos: temporada, rodada, status, dataInicio, dataFim.
Código: 1–10 caracteres ASCII maiúsculos ou números.
Temporada e rodada: inteiros entre 1 e 65535, compatíveis com as colunas MySQL existentes.
Status: SCHEDULED, TIMED, IN_PLAY, PAUSED, FINISHED, POSTPONED, SUSPENDED, CANCELLED, AWARDED.
Datas: YYYY-MM-DD ou timestamp ISO 8601 com segundos e fuso explícito.
Uma data sem hora representa UTC: dataInicio inclui o início do dia; dataFim inclui até 23:59:59.999 do dia.
Instantes com fuso são comparados pelo instante UTC correspondente. dataInicio deve ser menor ou igual a dataFim.
Filtros desconhecidos ou inválidos retornam HTTP 400 pelo ValidationPipe existente; competição inexistente retorna 404.

Jogos são ordenados por dataHoraUtc ASC e id ASC. Mandante e visitante são selecionados junto à consulta relacional, sem consultas individuais por clube.
A resposta seleciona apenas os campos do contrato, agrupa os placares e serializa datas em UTC ISO 8601.
Null permanece null e zero válido permanece zero.
Rodada válida sem partidas retorna HTTP 200 com total=0 e jogos=[].

## Regra de rodada atual

1. Considerar somente a temporadaAtual da competição e partidas com rodada não nula.
2. Buscar a menor rodada com status SCHEDULED, TIMED, IN_PLAY, PAUSED, POSTPONED ou SUSPENDED.
3. Se nenhuma existir, buscar a maior rodada com status FINISHED ou AWARDED.
4. Se nenhuma existir, retornar rodada=null, total=0 e jogos=[].
5. Retornar todos os jogos da rodada selecionada, incluindo encerrados ou cancelados dessa rodada.

CANCELLED nunca define a rodada. AWARDED é tratado como encerrado no fallback.
A regra não depende da data do sistema. Uma partida adiada antiga pode manter uma rodada anterior como atual, conforme o critério solicitado.

## Validação real no MySQL local

Os quatro endpoints foram exercitados via HTTP em uma instância temporária do FutebolQueryModule, com o mesmo ValidationPipe de produção.
O transporte fetch externo foi bloqueado durante a validação; o acesso HTTP local foi feito com node:http.
Nenhum dado foi alterado e nenhuma sincronização foi executada.

| Requisição | HTTP | Resultado |
| --- | --- | --- |
| /futebol/competicoes | 200 | BSA ativa, temporada 2026 |
| /futebol/competicoes/BSA/rodada-atual | 200 | Rodada 21, 10 jogos |
| /futebol/competicoes/BSA/rodadas/21 | 200 | Rodada 21, 10 jogos |
| /futebol/competicoes/BSA/jogos?temporada=2026 | 200 | 380 jogos |

Resposta real de GET /futebol/competicoes:

```json
[
  {
    "codigo": "BSA",
    "nome": "Campeonato Brasileiro Série A",
    "pais": "Brazil",
    "emblemaUrl": "https://crests.football-data.org/bsa.png",
    "temporadaAtual": 2026
  }
]
```

Resposta real de GET /futebol/competicoes/BSA/rodada-atual, abreviada para o primeiro dos 10 jogos:

```json
{
  "competicao": {
    "codigo": "BSA",
    "nome": "Campeonato Brasileiro Série A"
  },
  "temporada": 2026,
  "rodada": 21,
  "total": 10,
  "jogos": [
    {
      "id": 200,
      "externalId": 554940,
      "temporada": 2026,
      "rodada": 21,
      "fase": "REGULAR_SEASON",
      "grupo": null,
      "dataHoraUtc": "2026-07-29T00:00:00.000Z",
      "status": "POSTPONED",
      "vencedor": null,
      "mandante": {
        "id": 2,
        "externalId": 1766,
        "nome": "CA Mineiro",
        "nomeCurto": "Mineiro",
        "sigla": "CAM",
        "escudoUrl": "https://crests.football-data.org/1766.png"
      },
      "visitante": {
        "id": 16,
        "externalId": 4286,
        "nome": "RB Bragantino",
        "nomeCurto": "Bragantino",
        "sigla": "RBB",
        "escudoUrl": "https://crests.football-data.org/4286.png"
      },
      "placar": { "mandante": null, "visitante": null },
      "placarIntervalo": { "mandante": null, "visitante": null }
    }
  ]
}
```

GET /futebol/competicoes/BSA/rodadas/21 retornou o mesmo primeiro jogo e total=10.
GET /futebol/competicoes/BSA/jogos?temporada=2026 retornou total=380, começando por:
ID 1, externalId 554740, rodada 1, CA Mineiro 2–2 SE Palmeiras,
intervalo 1–1, status FINISHED, vencedor DRAW, 2026-01-28T22:00:00.000Z.

## Índices

Nenhuma nova migration ou índice.
O índice FUTEBOL_PARTIDA_COMPETICAO_ID_TEMPORADA_RODADA_idx atende competição/temporada e rodada.
EXPLAIN de consulta real por competição, temporada 2026 e rodada 24 selecionou esse índice,
acesso ref e estimativa de 10 registros, com filesort apenas para ordenar os registros selecionados.
A temporada tem 380 partidas; não há evidência para adicionar índices de status/data neste volume.
As FKs de clubes já têm índices. A listagem não faz N+1.

## Inventário da Fase 2

Arquivos criados:
- src/futebol/dto/futebol-query.dto.ts
- src/futebol/dto/futebol-response.dto.ts
- src/futebol/futebol-query.service.ts
- src/futebol/futebol.controller.ts
- src/futebol/futebol-query.module.ts
- test/futebol-query.spec.ts
- docs/football-data-fase-2.md

Arquivos alterados nesta fase:
- src/app.module.ts: registra somente o módulo de leitura.
- test/futebol.spec.ts: substitui ConfigService real por mocks de get para isolar o token do ambiente nos testes da Fase 1.

Outras alterações já presentes no working tree pertencem à Fase 1 e foram preservadas.

DTOs de entrada: FutebolCodigoParamsDto, FutebolRodadaParamsDto, FutebolJogosQueryDto.
DTOs de saída: FutebolCompeticaoResumoDto, FutebolCompeticaoResponseDto, FutebolTimeResponseDto,
FutebolPlacarDto, FutebolJogoResponseDto, FutebolJogosResponseDto.
Serviço novo: FutebolQueryService. Não foi necessário criar repository adicional sobre PrismaService.

## Resultado das verificações

- Testes novos: 49 testes HTTP em test/futebol-query.spec.ts, todos aprovados, cobrindo os 18 cenários solicitados e casos de borda.
- Suíte completa final: 568 testes executados e aprovados em 36 suítes; 24 testes ignorados em 7 suítes (592 testes descobertos).
- A primeira execução direcionada teve 73 aprovados e 2 falhas em testes da Fase 1 por interferência do token do ambiente; após isolar os mocks, ambos passaram na suíte completa.
- Build: npm.cmd run build aprovado, incluindo geração do Prisma Client e compilação Nest.
- Lint da entrega: npx.cmd eslint src/futebol src/app.module.ts test/futebol-query.spec.ts test/futebol.spec.ts aprovado.
- Lint global: uma única falha preexistente, variável _id sem uso em test/recarga-pix.integration.spec.ts:68. Arquivo não alterado.
- git diff --check aprovado.
- Confirmação explícita: nenhum endpoint de futebol chama football-data.org. Os testes bloqueiam fetch externo e verificam que os três métodos do FootballDataClient nunca são chamados; esse client nem está registrado no módulo HTTP de leitura.

## Decisões e pendências da entrega

- Módulo de leitura independente do módulo de sincronização para garantir isolamento do provedor externo.
- Datas sem hora incluem o dia inteiro no limite final; timestamps exigem fuso explícito para evitar dependência do fuso do servidor.
- Limite superior de temporada/rodada segue SMALLINT UNSIGNED, sem restringir rodadas a 38.
- Fallback considera FINISHED/AWARDED e exclui CANCELLED; sem rodada elegível, resposta vazia com rodada null.
- Sem paginação nesta fase: a consulta é sempre limitada a uma temporada, conforme o contrato solicitado.
- Dados retornados refletem a última sincronização manual; rodada 21 é esperada devido ao jogo POSTPONED.
- A validação real usou módulo HTTP isolado com MySQL real, sem iniciar os serviços de outros domínios.
- Na primeira execução dos testes antigos, ConfigService priorizou o token real do ambiente e o Jest o exibiu no diagnóstico da asserção. Os mocks foram corrigidos; recomenda-se rotacionar esse token. O valor não é reproduzido nesta documentação.
- O erro global de lint em test/recarga-pix.integration.spec.ts:68 foi preservado conforme instruído.
- Fase 3 não iniciada.
