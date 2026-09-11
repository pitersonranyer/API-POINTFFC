# Integração football-data.org — Fase 1

## Operação

Configure somente no backend, em .env ou no ambiente:

```dotenv
FOOTBALL_DATA_API_TOKEN=
```

Execute:

```sh
npx prisma migrate deploy
npm run build
npm run futebol:sync
```

O comando usa o DATABASE_URL existente e encerra a conexão ao terminar. Não inicializa AppModule, servidor HTTP, Cartola, Redis ou rotinas recorrentes. Não há endpoint novo nem chamada externa em acessos de usuários.

São feitas três consultas sequenciais: competição BSA, clubes e partidas da temporada identificada por currentSeason.startDate. As consultas de clubes e partidas recebem season explicitamente. Cada consulta tem timeout de 15 segundos, incluindo leitura do corpo. Não há retries automáticos, inclusive em 429. Os corpos de erro e erros originais de transporte não são exibidos.

Referências: [Competition v4](https://docs.football-data.org/general/v4/competition.html) e [Match v4](https://docs.football-data.org/general/v4/match.html).

## Relatório da entrega

1. **Arquivos criados:** src/futebol/football-data.client.ts; src/futebol/football-data.normalizer.ts; src/futebol/futebol-sync.service.ts; src/futebol/futebol.module.ts; scripts/sync-brasileirao.cjs; test/futebol.spec.ts; prisma/migrations/0013_create_futebol/migration.sql; docs/football-data-fase-1.md.
2. **Arquivos alterados:** .env.example; package.json; prisma/schema.prisma; src/config/environment.validation.ts.
3. **Migration:** 0013_create_futebol, aplicada com sucesso no MySQL local configurado. Nenhuma migration anterior foi alterada.
4. **Tabelas e campos:** listados abaixo, com todos os campos solicitados.
5. **Serviços:** FootballDataClient centraliza HTTP e erros sanitizados; normalizer valida o contrato com Joi e mapeia dados; FutebolSyncService valida o lote e realiza upserts em transação serializável. FutebolModule disponibiliza esses serviços para injeção futura.
6. **Execução manual:** npm run futebol:sync, após build. Nenhum endpoint adicionado.
7. **Testes:** 519 passaram em 35 suítes; 24 testes de 7 suítes foram ignorados. A entrega adiciona 26 testes, todos aprovados, com API mockada e persistência em memória.
8. **Build/lint:** npm.cmd run build passou. Lint dos arquivos TypeScript da entrega passou. Lint global falhou por erro preexistente em test/recarga-pix.integration.spec.ts:68: variável _id sem uso.
9. **API real:** não consultada, pois FOOTBALL_DATA_API_TOKEN não está configurado. O comando manual foi executado e retornou a mensagem sanitizada de token ausente.
10. **Clubes importados:** 0; contagem confirmada no MySQL.
11. **Partidas importadas:** 0; contagem confirmada no MySQL. Competições: 0.
12. **Três exemplos persistidos:** indisponíveis; nenhuma partida real foi importada. Após configurar o token, o comando retorna até três exemplos persistidos, com clubes, datas e placares.
13. **Decisões técnicas:** comando interno em lugar de endpoint; módulo não registrado no AppModule para manter execução exclusivamente manual. Temporada é o ano de início informado pelo provedor. Status é texto para preservar valores do provedor. Todo o lote é validado antes de qualquer gravação, e a persistência usa transação de até 120 segundos. Clubes desconhecidos em partidas e divergências de competição/temporada abortam o lote. Atualizações de partidas mais antigas que as locais são ignoradas. Chamadas simultâneas no mesmo serviço compartilham a execução.
14. **Pendências/riscos:** configurar token e validar o contrato e a importação reais. Os testes de persistência usam mocks, não validam rollback/concorrência no MySQL; a migration foi aplicada no MySQL real. Execuções em processos distintos não compartilham controle de chamadas e podem exigir repetição manual após conflito transacional. Corrigir o erro preexistente de lint em tarefa própria. Fase 2 não iniciada.

## Modelagem

Nomes de propriedades Prisma em camelCase, mapeados para colunas em maiúsculas. IDs inteiros sem sinal, datas DATETIME(3), timestamps de criação/atualização e tabelas InnoDB utf8mb4, seguindo os padrões existentes.

- **FUTEBOL_COMPETICAO:** ID, EXTERNAL_ID, CODIGO, NOME, PAIS, TIPO, EMBLEMA_URL, TEMPORADA_ATUAL, ATIVA, CRIADO_EM, ATUALIZADO_EM. EXTERNAL_ID e CODIGO únicos.
- **FUTEBOL_TIME:** ID, EXTERNAL_ID, NOME, NOME_CURTO, SIGLA, ESCUDO_URL, PAIS, CRIADO_EM, ATUALIZADO_EM. EXTERNAL_ID único; ESCUDO_URL preserva o conteúdo original.
- **FUTEBOL_PARTIDA:** ID, EXTERNAL_ID, COMPETICAO_ID, TEMPORADA, RODADA, FASE, GRUPO, TIME_MANDANTE_ID, TIME_VISITANTE_ID, DATA_HORA_UTC, STATUS, VENCEDOR, PLACAR_MANDANTE, PLACAR_VISITANTE, PLACAR_INTERVALO_MANDANTE, PLACAR_INTERVALO_VISITANTE, ULTIMA_ATUALIZACAO_API, CRIADO_EM, ATUALIZADO_EM. EXTERNAL_ID único; três FKs com exclusão restrita. Índices por competição/temporada/rodada e pelos clubes.

Datas são interpretadas como UTC e não são convertidas para Brasília. Placares null continuam null e zero válido continua zero. Upserts conciliam pelo EXTERNAL_ID. Nenhum registro é excluído por ausência em consultas posteriores.
