# Fase 3B.3.3B.1 — retomada e validação

Data: 20/10/2026. Repositório: `pitersonranyer/API-POINTFFC`.
Branch: `feat/point-fantasy-scoring-observation-3b2`.

## Estado encontrado

A inspeção encontrou o coletor diferencial e seus testes implementados, além do relatório
anterior e de artefatos de execução aprovada. Não foram encontradas funções pendentes,
testes desabilitados ou necessidade de recomeçar o serviço. Os resultados abaixo foram
obtidos novamente nesta retomada; os artefatos anteriores serviram apenas de referência.

O Git já continha alterações das fases anteriores em `package.json`, `prisma/schema.prisma`,
migrations 0028/0029, scripts, observação e testes. Um manifesto SHA-256 inicial preservou
a distinção entre esses arquivos e o trabalho desta retomada. Nenhuma alteração foi descartada.

Comparando com o manifesto inicial da implementação B.1, os arquivos acrescentados por
essa implementação são:

- `src/point-fantasy/observation/current-scoring.service.ts`;
- `src/point-fantasy/observation/current-scoring-plan.ts`;
- `src/point-fantasy/observation/current-scoring-policy.ts`;
- `test/point-fantasy-current-scoring.spec.ts`;
- `test/point-fantasy-current-scoring.integration.spec.ts`;
- `docs/point-fantasy-current-scoring-3b33b1.md`.

Os arquivos existentes modificados naquela implementação foram `observation.service.ts`,
`observation-errors.ts` e `scripts/point-fantasy-scoring-test.cjs`. Os demais arquivos
preexistentes foram reaproveitados, incluindo HTTP, parser, normalizador, retry, schema,
migration 0029 e backfill. A descrição técnica completa permanece no relatório anterior.

## Alterações desta retomada

- Modificado somente `test/point-fantasy-current-scoring.spec.ts`: dois testes adicionais
  verificam a recusa de `NODE_ENV=production`, mesmo com política de evidências injetada,
  e a recusa quando `DATABASE()` não coincide com o schema isolado autorizado. Neste último
  caso, não ocorre transação, HTTP ou avaliação de evidências. São mocks; nenhum acesso
  a produção ou escrita no principal é realizado por esses testes.
- Criado este relatório. Não foi necessário alterar o código de produção.

## Funcionalidades confirmadas

O novo serviço estende o mecanismo legado, sem duplicar HTTP, identidade, UUID, lease,
fence, retry ou recuperação. Insere atletas/técnicos novos e atualiza apenas linhas
alteradas. Preserva linhas semanticamente idênticas, inclusive tokens e timestamps.
Omissões autorizadas preservam valores e participação e alteram somente presença;
reaparecimento é uma mudança explícita. Zero, negativo, nulo e ausente permanecem distintos,
com Decimal/DECIMAL(38,18), tokens originais, scouts e IDs Cartola.

Revisão, linhas, hashes, diferenças e resultado da coleta são atômicos. Consultas idênticas
não avançam revisão; A → B → A produz revisões distintas. O histórico contém somente as
diferenças, sem novos snapshots completos. O escritor ATUAL não escreve nas tabelas de
snapshots; o escritor legado continua compatível.

O retry reexecuta a transação completa, no máximo quatro tentativas, com atrasos controlados.
Reconhece P2034 e P2010 somente com código MySQL 1213; P2002 tem tratamento restrito à
aquisição/idempotência. Não repete HTTP por falha de persistência. UUID, autorização final,
lease e fence continuam conferidos, inclusive após rollback ou perda de confirmação do commit.

## Política efetiva de evidências

Não existe nesta entrega um verificador oficial aprovado que comprove completude e ordem.
O padrão retorna ausência de certificado: primeira carga e qualquer mudança são registradas
como rejeitadas, sem alterar pontuações. Uma resposta semanticamente idêntica pode ser
registrada como SEM_ALTERACAO, sem avançar revisão ou reduzir a ordem certificada anterior.

Date, Age, recebimento, fence e ordem local não autorizam alterações isoladamente.
Metadados de cache podem ser sinais negativos. Um futuro certificado deve vincular identidade,
payload, base, lista completa e sequência crescente da fonte; correções após validação
exigem aprovação explícita. Identidade histórica sem temporada comprovável continua bloqueada.

O único emissor de certificados disponível é `fixture-only-v1`, definido nos testes.
Não constitui evidência oficial, não está registrado no aplicativo e não possui opção de
ativação em produção. O serviço atual exige URL local de teste, confere o schema conectado
e bloqueia ambiente production. Não há endpoint, scheduler ou comando novo de coleta.

## Validações executadas nesta retomada

| Execução | Resultado |
|---|---|
| `node scripts/point-fantasy-scoring-test.cjs` | 9 suítes, 171 testes aprovados |
| Regressão Jest unitária `point-fantasy`, excluindo `integration.spec.ts` | 14 suítes, 322 testes aprovados |
| Prisma validate | Aprovado |
| Prisma generate | Aprovado, executado pelo build |
| `npm run typecheck` | Aprovado |
| `npm run lint` | Aprovado |
| `npm run build` | Aprovado |

Os totais se sobrepõem e não devem ser somados. Zero falhas e zero testes ignorados nas
seleções executadas. Não foi executada a suíte completa do repositório nem as integrações
tradicionais fora do escopo. Uma primeira tentativa de iniciar a regressão unitária teve
erro de quoting do PowerShell antes de executar testes; foi corrigida usando entrada padrão
do Node, e a execução efetiva passou integralmente.

Cobertura: primeira carga, idêntica, um/vários alterados, inclusão, omissão, reaparecimento,
A → B → A, zero/negativo/nulo/ausente, precisão, revisão atômica, UUID repetido, concorrência,
deadlock e esgotamento, lease/fence, rollback, ausência de duplicidade, resposta antiga,
identidade histórica pendente e correção após validação. Os warnings de falhas de banco,
autorização e trabalhador atrasado nos logs são cenários de falha deliberadamente injetados.

## Integridade e isolamento

Foram reutilizados exclusivamente os schemas ensaiados:

- A: `point_fantasy_observation_3b2_test_1792507380793`;
- B: `point_fantasy_observation_3b2_test_1792507380794`.

O coletor foi exercitado no B; estrutura/backfill foram exercitados em A e B. As respostas
HTTP são fixtures, sem coletas reais. Não foi aplicada nenhuma migration nesta retomada.
As estruturas finais A/B correspondem às estruturas registradas no ensaio da 0029,
incluindo tipos, CHECKs, índices e FKs. O runner confirmou a preservação do snapshot original
com 275 registros, das três coletas legadas, das tabelas tradicionais e de `_prisma_migrations`.
Os dados sintéticos das suítes ficam somente nos schemas descartáveis.

O fingerprint de dados e DDL do principal foi comparado em leitura com a referência anterior
e permaneceu idêntico. A migration 0029 continua ausente do principal. Nenhuma migration
anterior foi editada; a divergência histórica de proveniência de 0024/0025 permanece aberta.

Evidências desta retomada: `C:/Users/piter/AppData/Local/Temp/point-fantasy-3b33b1-resume-9P7E6D`.
Incluem manifesto inicial, classificação por fase, resultados/logs Jest, verificação de
integridade e comparação final de arquivos. Os artefatos temporários não contêm URLs de conexão.

## Riscos e condições para 3B.3.3B.2

1. Revisar um contrato oficial verificável de completude, identidade e ordem/correções antes
   de permitir mudanças reais. Os testes com certificados artificiais validam o mecanismo,
   não a existência desse contrato na fonte.
2. Definir identidade histórica comprovável e política oficial de encerramento. O coletor
   não promove automaticamente uma rodada a VALIDADA.
3. Planejar o corte do escritor legado e sincronização do backfill. Se o legado avançar
   depois da base atual, a aplicação é bloqueada; não há rebase automático.
4. Manter a proveniência de 0024/0025 como pendência explícita, sem alterar checksums ou
   apresentar reconstrução como recuperação do SQL originalmente executado.
5. Qualquer aplicação da 0029/backfill no principal exige autorização posterior, backup
   verificável e procedimento controlado ensaiado. Esta entrega permanece desativada ali.
6. Planejar limites transacionais e leitura consistente de revisões pelo futuro motor.
   Cálculo de escalações e rankings permanecem fora desta implementação.

As validações necessárias desta fase passaram. Isso não autoriza ativação operacional.
O Git permanece na branch esperada, com as alterações anteriores sem commit e apenas
o teste adicional e este relatório alterados/criados durante a retomada. Não houve reset,
clean, stash, commit, push, merge, deploy ou alteração de funcionalidades tradicionais.
