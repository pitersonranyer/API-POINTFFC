# POINT FFC Fantasy — correção isolada de deadlock, 3B.3.3A.3

Data: 20/10/2026. Branch mantida: `feat/point-fantasy-scoring-observation-3b2`.

## Diagnóstico confirmado

Antes de editar o serviço, a suíte reproduziu a falha em schema MySQL isolado:
24 testes aprovados e falha em `serializes simultaneous lease acquisitions and permits later reuse`.
A instrumentação identificou exatamente:

```text
PrismaClientKnownRequestError
code: P2010
meta.code: "1213"
meta.message: Deadlock found when trying to get lock; try restarting transaction
SELECT ID FROM FANTASY_APURACAO_RODADA WHERE ID=? FOR UPDATE
```

O trecho LATEST DETECTED DEADLOCK do InnoDB foi capturado imediatamente e conferido contra
o nome do schema isolado usado pelo teste. Ele mostra duas transações concorrentes na mesma
linha/índice PRIMARY da apuração: uma aguardando X e outra mantendo S enquanto também aguarda X.
O InnoDB escolheu a primeira como vítima e realizou rollback.

O caminho de aquisição usava `upsert` Prisma com `update: {}` antes do `FOR UPDATE`.
A leitura sob Serializable podia manter lock compartilhado antes da solicitação do exclusivo.
O ciclo observado é de conversão/fila de locks na mesma linha; não foi encontrada uma inversão
comprovada da ordem entre tabelas. Aquisição, conclusão e recuperação já acessam a apuração
antes das coletas/snapshots. Essa ordem foi preservada.

As evidências locais estão em:
`C:/Users/piter/AppData/Local/Temp/point-fantasy-3b33a3-DnhE9A`.
Arquivos: `before-fix.log`, `innodb-deadlock.txt`, `phase-tests.json`, `phase-tests.log`,
`unit-regression.json`, `unit-regression.log`, `post-tests-integrity.json`, `initial.json`.
A instrumentação temporária foi removida; nenhum logger de SQL bruto foi incluído no serviço.

## Correção

1. A primeira operação da transação de aquisição passou a ser:

   ```sql
   INSERT INTO FANTASY_APURACAO_RODADA (TEMPORADA, RODADA, ATUALIZADO_EM)
   VALUES (?, ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE ID=ID;
   ```

   Ela cria a apuração ou toma o lock exclusivo da existente sem alterar seus valores.
   Em seguida, a identidade é lida com `FOR UPDATE`. Isso elimina a leitura compartilhada
   anterior à conversão que apareceu no diagnóstico. A alteração é DML interno ao serviço,
   não DDL ou mudança da estrutura. Foi executada somente nos testes isolados.

2. O retry executa novamente a transação DB completa, com até **quatro tentativas totais**.
   Os intervalos são **25, 50 e 75 ms**, sem sleep após o último erro.
   Reconhece somente instâncias reais de `PrismaClientKnownRequestError` com:
   - `P2034`: conflito transacional reconhecido pelo Prisma;
   - `P2010` e `meta.code` exatamente `"1213"` ou `1213`.

3. Não consulta texto de mensagem para decidir retry. `P2010` sem esse código, erro de sintaxe
   1064, timeout 1205, FK 1452, objetos que apenas imitam a forma do erro e exceções comuns
   não recebem retry de deadlock.

4. O tratamento anterior de corrida de unicidade `P2002` foi mantido somente na transação
   inicial, para reler o proprietário do UUID depois de uma disputa. Não é classificado como
   deadlock e não causa retry genérico da persistência/recuperação.

5. Ao esgotar tentativas, o erro chega ao tratamento existente. Deadlocks recebem código
   sanitizado `DB_TRANSACTION_CONFLICT_<ETAPA>`; falhas permanentes conservam seus diagnósticos.
   Não há conversão de falha em sucesso.

## Autorizações, idempotência e HTTP

- UUID e token são criados fora do callback repetido e preservados entre tentativas.
- O fetch não fica dentro do retry: uma observação válida continua fazendo quatro chamadas
  simuladas, mesmo quando a persistência sofre deadlock e repete a transação.
- Cada repetição refaz a leitura do estado terminal, lease, token e fence. A autorização final
  com relógio UTC do banco continua sendo a última escrita da transação.
- O retry não renova lease nem reduz fence. Autorização perdida interrompe a tentativa.
- A sequência de snapshots, seus lotes, a associação da coleta e o contador sofrem rollback
  juntos antes de uma nova tentativa. Resultados terminais já confirmados continuam prevalecendo.
- A recuperação de confirmação de commit perdida permanece coberta pelos testes anteriores.

## Arquivos desta fase

Modificados:

- `src/point-fantasy/observation/observation.service.ts`: aquisição exclusiva e uso do retry;
- `src/point-fantasy/observation/observation-errors.ts`: classificação sanitizada do deadlock;
- `test/point-fantasy-observation.integration.spec.ts`: dez casos adicionais, sem remover
  ou reduzir as verificações anteriores.

Criados:

- `src/point-fantasy/observation/observation-retry.ts`;
- `test/point-fantasy-observation.retry.spec.ts`;
- este relatório.

O manifesto por SHA-256 confirma preservação dos demais arquivos que já existiam ao início.
SQLs 0024, 0025, 0028 e 0029, schema Prisma, backfill, scripts da fase anterior,
cliente HTTP, parser, normalizador e funcionalidades tradicionais não foram alterados.

## Testes executados nesta fase

| Execução | Resultado |
|---|---|
| Reprodução antes da correção | 24 aprovados, uma falha de concorrência |
| Observação + estrutura, versão final | **7 suítes / 128 testes aprovados**, zero falhas ou ignorados |
| Testes novos de retry | 15 unitários e dez integrações adicionais, incluídos no total acima |
| Regressão unitária POINT Fantasy | **13 suítes / 304 testes aprovados**, zero falhas ou ignorados |
| Typecheck | Aprovado |
| Lint | Aprovado |
| Prisma validate | Aprovado |
| Prisma generate | Executado pelo build |
| Build | Aprovado |

As contagens se sobrepõem e não devem ser somadas. Não foi executado o conjunto completo do
repositório nem as integrações tradicionais de escalações; elas foram excluídas da regressão unitária.
Os resultados negativos anteriores foram preservados como evidência, não omitidos.

Casos cobertos: P2010/1213 e P2034 na aquisição e após dois lotes gravados; rollback real dos lotes
e contador; persistência com um único snapshot/UUID após retry; P2010/1064 sem retry; esgotamento
de quatro tentativas; aquisição esgotada sem HTTP ou linhas residuais; lease expirado/fence alterado
entre rollback e retry; duas coletas concorrentes; UUID simultâneo e repetido; commit sem confirmação.
As falhas injetadas usam erros reais da classe Prisma e transações MySQL que efetivamente fazem
rollback; o deadlock inicial também foi reproduzido pelo próprio InnoDB.

## Integridade e escopo de execução

Foram reutilizados exclusivamente os schemas isolados A/B da fase anterior. Não houve nova
aplicação de migration ou execução de backfill no principal. O script de testes direciona o
DATABASE_URL dos subprocessos ao schema B; as respostas HTTP são simuladas.

Após a suíte, `post-tests-integrity.json` confirmou:

- dados e DDL do principal iguais ao fingerprint anterior;
- tabelas tradicionais e histórico de migrations dos testes inalterados;
- snapshot original e seus 275 registros preservados;
- três coletas legadas preservadas;
- testes aprovados.

Os novos casos usam temporadas sintéticas e não escrevem em FANTASY_PONTUACAO_ATLETA.
Os testes da estrutura/backfill também foram aprovados sem modificar seus arquivos.

## Riscos e estado final

Não restam falhas nas verificações selecionadas. O lock exclusivo inicial elimina o ciclo
observado, mas não promete ausência de qualquer deadlock causado por outros escritores.
O limite de tentativas continua sendo um limite real: sob contenção persistente, a coleta falha
com evidência, sem publicação parcial. O tempo das transações pode consumir o lease; nesse caso,
a autorização é rejeitada, sem extensão automática.

O INSERT com chave duplicada pode consumir valores de AUTO_INCREMENT mesmo sem inserir uma
nova linha. IDs técnicos não têm garantia de sequência sem lacunas; a identidade de negócio
continua única por temporada/rodada e UUID da coleta.

A divergência histórica de checksums de 0024/0025 continua aberta. Nenhuma alteração no principal
foi autorizada por esta entrega. A observação continua no modelo legado até a fase 3B.3.3B.

Branch preservada. Três arquivos anteriores modificados e três novos arquivos desta fase;
as alterações locais das fases anteriores permanecem presentes. Não houve commit, push,
merge, deploy, acesso a produção ou coleta real.
