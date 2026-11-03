# POINT FFC Fantasy — estrutura simplificada, 3B.3.3A.2

Data: 20/10/2026. Branch: `feat/point-fantasy-scoring-observation-3b2`.

## Escopo e limites

Esta entrega prepara três tabelas ativas para a fase 3B.3.3B. O coletor existente continua
gravando snapshots: não houve alteração de serviço, HTTP, bootstrap, cálculo ou ranking.
As tabelas de snapshots, seus dados e as FKs existentes permanecem preservados.
O principal `fantasy_point_do_jogador` foi consultado e copiado com mysqldump, sem DDL/DML.
Não houve coleta real, commit, push ou deploy de aplicação.

## Proveniência histórica ainda aberta

| Migration | Checksum registrado no principal | SHA-256 do arquivo/Git |
|---|---|---|
| 0024 | `01a5023fd78293a0a02cb38943e1066545c56031d9ec8650ca27174d69d349f4` | `3ad34fcd32e9f0c8de1b992d1dc4cf0842156bdb5ca1bdd31bb77e94c9411eb0` |
| 0025 | `d6514954e86ce2b5d2c8a3aa69225a72c3804fe9ca5271ef802c7c6195a65b1b` | `7fa6c71056791a429ecc57c9a33e4ff0cc84338f1f705a7f33266c294b1376e2` |

Essa exceção conhecida é explícita no ensaio, não uma reconciliação. Qualquer outra
divergência é rejeitada. Os SQLs 0024, 0025 e 0028 não foram alterados.
0028 permanece com SHA-256 `d957effe85788abbf1a6df3b4035fe78ce66aad1071f8e7c58fe07cf3ccfb305`.

## Arquivos desta fase

- Alterado: `prisma/schema.prisma` (adições sobre a implementação sem commit preservada).
- Criado: `prisma/migrations/0029_point_fantasy_current_scoring/migration.sql`.
- Criados: `scripts/point-fantasy-scoring-{backfill,rehearsal,test}.cjs`.
- Criado: `test/point-fantasy-scoring-structure.integration.spec.ts`.
- Ajustado: adaptador de transações em `test/point-fantasy-observation.integration.spec.ts`.
  O spread perdia métodos não enumeráveis do Prisma, incluindo `$queryRaw`; agora há fallback via Proxy.
- Ajustado: comentário de lint para o require CJS em `test/point-fantasy-observation.safety.spec.ts`.
- Criado: este relatório.

O `package.json` já estava modificado antes e não recebeu novas alterações.
Não foram descartados arquivos anteriores, inclusive `.phase5b2*` e a tentativa 3B.3.1.

## Estrutura implementada

### FANTASY_PONTUACAO_ATLETA

| Campos | Tipo / regra |
|---|---|
| TEMPORADA, RODADA, ATLETA_ID_CARTOLA | SMALLINT UNSIGNED, TINYINT UNSIGNED, INT UNSIGNED; PK composta |
| APURACAO_ID | INT UNSIGNED; FK composta com temporada e rodada |
| CLUBE_ID_CARTOLA, POSICAO_ID | INT UNSIGNED NULL, TINYINT UNSIGNED NULL; posição 6 aceita |
| ESTADO_CLUBE, ESTADO_POSICAO, ESTADO_PONTUACAO, ESTADO_PARTICIPACAO, ESTADO_SCOUTS | ENUM AUSENTE/NULO/VALOR |
| PONTUACAO | DECIMAL(38,18) NULL |
| PONTUACAO_TOKEN_ORIGINAL | VARCHAR(128) NULL |
| ENTROU_EM_CAMPO | BOOLEAN NULL |
| PARTICIPACAO_OBSERVADA | Enum existente, independente da presença na lista |
| SCOUTS | JSON NULL; objeto quando estado VALOR |
| PRESENTE_NA_ULTIMA_LISTA | BOOLEAN obrigatório |
| HASH_CONTEUDO, VERSAO_NORMALIZADOR | CHAR(64), VARCHAR(32) |
| REVISAO_ALTERACAO | BIGINT UNSIGNED > 0 |
| COLETA_ALTERACAO_ID | INT UNSIGNED; FK composta com APURACAO_ID |
| CRIADO_EM, ALTERADO_EM | DATETIME(3) |

Índices: identidade da apuração, coleta/apuração, apuração/clube e apuração/revisão.
Todas as novas FKs usam ON DELETE/UPDATE RESTRICT. Os CHECKs de campos do snapshot
foram reaproveitados com nomes próprios: zero, negativos, NULL e AUSENTE continuam distintos.

### FANTASY_APURACAO_RODADA

Mantém todos os campos antigos, inclusive contador de snapshot, lease, token, fence e identidade.
Acrescenta:

- `REVISAO_ATUAL BIGINT UNSIGNED DEFAULT 0`, `REVISAO_VALIDADA BIGINT UNSIGNED NULL`;
- `HASH_CONTEUDO_ATUAL CHAR(64) NULL`, `VERSAO_NORMALIZADOR VARCHAR(32) NULL`;
- `ULTIMA_COLETA_APLICADA_ID`, `COLETA_VALIDACAO_ID INT UNSIGNED NULL`;
- `VALIDADA_EM DATETIME(3) NULL`.

Estados: OBSERVANDO, AGUARDANDO_VALIDACAO, VALIDADA, EM_REVISAO. Não há promoção automática.
Os ponteiros de coleta possuem índices e FKs compostas que exigem a mesma apuração.
CHECKs exigem metadados da revisão vigente quando revisão > 0, validação completa ou inteiramente
nula e revisão validada <= atual. VALIDADA exige igualdade das revisões.
Esses CHECKs não provam encerramento oficial: a política e sua execução pertencem à fase futura.

### FANTASY_PONTUACAO_COLETA

Mantém dados, colunas, índices e FKs legados. Acrescenta:

- `MODELO_PERSISTENCIA ENUM(SNAPSHOT_LEGADO, ATUAL) DEFAULT SNAPSHOT_LEGADO`;
- `REVISAO_BASE`, `REVISAO_RESULTANTE BIGINT UNSIGNED NULL`;
- `HASH_CONTEUDO CHAR(64) NULL`, normalizador/fonte/política `VARCHAR(32) NULL`;
- `RECEBIDA_EM DATETIME(3) NULL`;
- `RESULTADO_APLICACAO ENUM(APLICADA, SEM_ALTERACAO, REJEITADA, NAO_APLICAVEL) NULL`;
- quatro contadores `INT UNSIGNED NULL`;
- `ALTERACOES`, `EVIDENCIA_ENCERRAMENTO JSON NULL`, `MOTIVO VARCHAR(255) NULL`;
- unique `(ID, RODADA_ID)` para as novas referências compostas.

A única restrição substituída é `FPC_SNAPSHOT_CHECK`, por `FPC_MODELO_CHECK`:

- legado: sucesso exige snapshot; não sucesso exige snapshot nulo; revisão/resultado novos nulos;
- atual: snapshot sempre nulo; sucesso exige identidade de conteúdo, fonte, recebimento e contadores;
- APLICADA exige revisão resultante = base + 1;
- SEM_ALTERACAO exige revisão positiva igual à base, sem inserções/alterações/omissões;
- não sucesso não produz revisão resultante nem contadores de aplicação positivos.

`FPC_TERMINAL_CHECK` permanece. Defaults preservam o coletor antigo.
Decimais em futuras diferenças JSON devem ser strings; isso será responsabilidade do novo escritor.

## Backfill

O script aceita somente URLs locais de schemas `point_fantasy_observation_3b2_test_<número>`.
Não possui fallback para DATABASE_URL no CLI, não contém HTTP ou DDL e recusa produção/principal.

Executa transação Serializable com lock da apuração; exige OBSERVANDO, sem lease e sem coleta
em andamento. Seleciona o último sucesso legado por fence, conclusão e ID, incluindo A → B → A.
Não escolhe simplesmente a maior versão de snapshot.

Registra uma operação local ATUAL/SUCESSO, endpoint LOCAL_BACKFILL, UUID determinístico e motivo
com snapshot/coleta de origem. Não é nova consulta oficial. As três coletas antigas ficam intactas.
Copia os campos diretamente com INSERT ... SELECT, sem conversão decimal para Number.
Inicializa revisão 1; não altera estado para VALIDADA, revisão validada, lease ou fence.

Na repetição, verifica origem, revisão, metadados e todas as linhas; retorna a mesma operação sem
escrita. Base legada alterada ou destino já ocupado sem origem reconhecida causam recusa,
não upsert destrutivo. Verifica correspondência null-safe campo a campo e JSON semântico.

IMPORTANTE: o coletor antigo ainda pode gerar novas observações após o backfill. A tabela atual
não acompanha essas alterações nesta fase e não deve alimentar cálculo. A 3B.3.3B deverá definir
o corte, pausar o escritor antigo e revalidar a base. O backfill recusa sobrescrever
uma inicialização que ficou defasada: requer procedimento explícito para essa situação.

## Ensaio reproduzível

Pré-requisitos locais: dependências instaladas, MySQL 8 com CHECKs aplicados e executáveis
`mysql.exe`/`mysqldump.exe` em `C:/Program Files/MySQL/MySQL Server 8.0/bin`.

```powershell
node scripts/point-fantasy-scoring-rehearsal.cjs
node scripts/point-fantasy-scoring-test.cjs
```

O primeiro comando gera nomes inéditos, backup e evidências em OS temp. Cada tentativa é preservada.
Ele captura dados e DDL de todas as tabelas do principal, confere histórico e migrations e realiza
mysqldump com transação consistente, sem locks de tabelas. O dump não contém USE/CREATE DATABASE.
Se o principal mudar durante a cópia, a execução é rejeitada.

- **A:** restaura o dump completo, verifica os fingerprints e preserva o histórico original.
- **B:** usa pasta temporária contendo exclusivamente 0001–0028. 0001–0027 são comparadas ao
  Git HEAD; 0028 é a implementação local preservada, ainda sem commit, com checksum conferido.
  Só nessa pasta e schema isolados executa migrate deploy. Copia as quatro tabelas de observação
  como fixture, sem copiar o histórico real para B.
- Executa exatamente o SQL 0029 via mysql em cada alvo isolado. Não usa deploy na restauração
  nem escreve um registro artificial da 0029 em `_prisma_migrations`.
- Executa backfill duas vezes, confere legados, tabelas tradicionais, histórico e principal.
- Compara SHOW CREATE de todas as tabelas: tipos, índices, CHECKs e FKs. Ignora apenas valor
  corrente de AUTO_INCREMENT e declaração redundante de charset de coluna igual ao da tabela.

O script de testes direciona também DATABASE_URL ao schema B nos subprocessos, além das variáveis
específicas. As APIs oficiais são simuladas. Os schemas e backups ficam retidos, sem DROP/reset.
Após execução manual do SQL, NÃO usar migrate deploy nesses schemas: a 0029 não está registrada.
Recomeçar um ensaio sempre cria schemas novos.

## Evidências desta execução

Diretório do ensaio final: `C:/Users/piter/AppData/Local/Temp/point-fantasy-3b33a2-G5h6NE`.
O manifesto inicial anterior às edições e os testes de controle/regressão unitária estão em
`C:/Users/piter/AppData/Local/Temp/point-fantasy-3b33a2-5QACZz`.
As evidências contêm backup, hashes de todas as tabelas, DDL comparado e logs locais de testes.

| Verificação | Resultado |
|---|---|
| A restaurado | `point_fantasy_observation_3b2_test_1792507380793` |
| B reconstruído | `point_fantasy_observation_3b2_test_1792507380794` |
| Estruturas A/B | Iguais após 0029 |
| Backfill por cenário | 275 registros, 20 técnicos, origem snapshot 1 |
| Soma por cenário | `1169.590000000000001000`, exata e igual à origem |
| Segunda execução | Mesma coleta local 4; nenhuma mudança de linha, data ou contador |
| Coletas 1–3, snapshots e tabelas tradicionais | Preservados no ensaio |
| Principal | Fingerprints de dados e DDL inalterados no ensaio |
| Integridade após testes | Principal, tabelas tradicionais, histórico, snapshot original e coletas legadas inalterados |
| Testes novos | 16 aprovados, cobrindo os dois cenários |
| Testes de fase + observação | 102 aprovados, 1 falha de concorrência; nenhum ignorado |
| Regressão unitária POINT Fantasy | 12 suítes, 289 testes aprovados; nenhum ignorado |
| Controle anterior à 0029 | 24 testes aprovados e a mesma falha de concorrência, em base/client até 0028 |
| Prisma validate/generate, typecheck, lint, build | Aprovados |

As contagens de testes acima se sobrepõem: não devem ser somadas.
Testes de integração tradicionais de escalação não foram executados nesta entrega.
Não houve testes ignorados nas execuções selecionadas; as suítes tradicionais de integração
foram explicitamente excluídas da regressão unitária. O conjunto completo do repositório não foi executado.
O runner de fase termina com código não zero pela falha conhecida, mesmo com a integridade preservada.

SHA-256 da nova migration 0029:
`df2a5744867641f015ed6e28d447d66ffd705f589ec7c6f2c270d12f913e9c48`.

O primeiro ensaio foi interrompido por comparação textual de charset; os dados já eram iguais.
Outro ensaio detectou ordem de propriedades na serialização dos fingerprints. As comparações foram
corrigidas para equivalência de charset e ordenação canônica de objetos, sem mudar valores comparados.

## Riscos e próximo passo

- Proveniência de 0024/0025 permanece aberta; os dois cenários não recuperam os SQLs originais.
- A regressão de concorrência encontrou deadlock MySQL 1213 retornado como Prisma P2010.
  O coletor atual repete P2034/P2002, não esse código. Serviço preservado nesta fase.
  O mesmo teste falhou também no controle reconstruído sem 0029, com client gerado do schema anterior.
  Portanto, não se trata de incompatibilidade demonstrada pela nova estrutura. A suíte continua
  sinalizando a falha; ela não foi ignorada ou enfraquecida para produzir resultado verde.
- DDL MySQL tem commits implícitos. Interrupção exige inspeção por etapa, não pressuposição de rollback
  integral. Nos ensaios, abandonar o alvo incompleto e usar outro schema; não apagar dados.
- Para o principal: aprovação posterior, backup novo e restauração ensaiada, revisão de pendências,
  política explícita para o histórico divergente e ensaio dos artefatos finais são obrigatórios.
- Para 3B.3.3B: resolver a regressão de concorrência, implementar escritor diferencial, deltas exatos,
  revisão atômica, tratamento de omissões/cache, identidade histórica e política de encerramento.
  O futuro motor deverá consumir revisão consistente e validar revisão atual/validada.

Nenhum resultado histórico foi contado como teste desta entrega.

## Estado final do Git

Comparação por hash com o manifesto anterior às edições: somente três arquivos existentes
mudaram nesta fase (`schema.prisma` e os dois testes de observação citados). Foram criados os
seis arquivos listados acima: migration, três scripts, teste de estrutura e relatório.
O serviço, cliente HTTP, normalizador, scripts antigos, package.json e SQLs anteriores permanecem
byte a byte iguais ao início. A branch foi mantida e nenhum commit foi criado.
