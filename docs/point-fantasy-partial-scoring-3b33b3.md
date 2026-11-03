# POINT FFC Fantasy — pontuação parcial, Fase 3B.3.3B.3

Data: 20/10/2026. Branch: `feat/point-fantasy-scoring-observation-3b2`.

## Escopo e arquivos

O coletor diferencial existente foi reaproveitado. Não foi criado outro serviço,
endpoint, scheduler, tabela, enum ou migration. O padrão continua bloqueando mudanças
sem certificação forte; a aceitação parcial exige construção explícita do mesmo
`CurrentScoringService` com `partialScoringPolicy` como quinto argumento.
As barreiras de URL local de teste, DATABASE() e NODE_ENV=production permanecem.

Arquivos modificados nesta fase, comparados com manifesto inicial SHA-256:

- `src/point-fantasy/observation/current-scoring-policy.ts`: política operacional
  `PARCIAL`, versão `partial-v1`, separada de `ScoringEvidencePolicy` e seus certificados.
- `src/point-fantasy/observation/current-scoring-plan.ts`: opção para preservar omissões,
  com comportamento anterior mantido por padrão para o caminho de certificação forte.
- `src/point-fantasy/observation/current-scoring.service.ts`: decisão parcial, retenções,
  detecção de conteúdo anterior/cache e proteção de pontuação validada.
- `test/point-fantasy-current-scoring.integration.spec.ts`: 20 casos adicionais de
  integração da política parcial, reutilizando as mesmas fixtures e instrumentação.

Criado: este relatório. As alterações locais anteriores foram preservadas, inclusive
package.json, schema Prisma, migrations não rastreadas e demais scripts/testes das fases
anteriores. Nenhum desses arquivos foi descartado ou reconciliado.

## Nomenclatura

Os conceitos de produto são PARCIAL, EM APURAÇÃO e DEFINITIVA. Não foi criada uma
categoria adicional de pontuação. Permanecem os estados técnicos OBSERVANDO,
AGUARDANDO_VALIDACAO, VALIDADA e EM_REVISAO. Esta fase não implementa apresentações
públicas ou transições automáticas entre esses estados.

PARCIAL usa valores efetivamente recebidos da fonte, nunca estimativas. A presença
de uma revisão corrente não significa que ela tenha sido validada.

## Aceitação e rejeição

O fluxo compartilhado exige JSON estrito, temporada/rodada contextual coincidente
no mercado antes/depois, estado do mercado consistente, rodada do payload correta
e temporada do payload compatível quando informada. Histórico sem identidade
comprovável permanece IDENTIDADE_PENDENTE. Quantidade declarada incompatível é recusada.
HTTP, identidade, UUID, lease, fence, retry e recuperação não foram reimplementados.

A política parcial não fornece certificados, não declara completude e não inventa
sequência oficial. Sua aceitação operacional é registrada em LIMITACOES, com modalidade,
versão e códigos OFFICIAL_FRESHNESS_NOT_PROVEN/COMPLETENESS_NOT_PROVEN. EVIDENCIA_FONTE
permanece nula no caminho parcial. A política forte e o emissor exclusivo das fixtures
continuam separados; nenhuma mudança foi feita para habilitar fixtures em produção.

Recusas adicionais da política parcial:

- apuração VALIDADA ou qualquer REVISAO_VALIDADA existente, inclusive EM_REVISAO;
- primeira lista vazia;
- perda de campo anteriormente informado, inclusive códigos individuais de scouts;
- omissão de pelo menos 50% dos atletas vigentes;
- Age positivo/inválido, Date inválido/futuro ou regressivo em relação à última coleta
  de sucesso, além dos controles já existentes sobre evidência certificada;
- conteúdo semanticamente observado anteriormente quando sua aplicação mudaria a base
  corrente, incluindo A → B → A. A pesquisa também considera observações rejeitadas
  com hash retido e hashes legados compatíveis; não usa apenas os bytes do payload.

O limiar de 50% é uma decisão operacional conservadora da versão partial-v1, não
uma garantia atribuída ao Cartola. Mesmo uma única omissão em uma base de um ou dois
atletas pode bloquear a resposta. A lista de IDs observados como omitidos é auditada.

Nenhuma resposta suspeita é aplicada parcialmente. A resposta inteira é rejeitada,
os valores vigentes são retidos e o motivo é registrado. Isso também preserva campos
válidos que tenham mudado na mesma resposta: opção intencional de segurança desta versão.
Não existe liberação automática após repetição nem procedimento de override nesta fase.

## Omissões, estados e cache

Omissão abaixo do limiar não exclui atleta, não zera pontos, não altera participação
nem o marcador PRESENTE_NA_ULTIMA_LISTA. Os IDs omitidos ficam em LIMITACOES.
QTD_OMITIDOS continua indicando omissões efetivamente aplicadas à presença, portanto
é zero no caminho parcial; não deve ser usado para contar omissões apenas observadas.

Quando um campo VALOR desaparece ou passa a NULO, a coleta registra atleta, campo,
estado anterior/recebido e motivo INFORMED_FIELD_LOST. Valores e tokens anteriores
permanecem nas linhas vigentes. Perda de scout é tratada da mesma forma. Estados
NULO/AUSENTE numa primeira inclusão são preservados, sem conversão para zero.

Zero, negativos e reduções legítimas são aceitos se não houver outro sinal de suspeita.
O sinal ou crescimento de pontos não participa da decisão de frescor. Redução que
coincida com uma versão histórica pode ser bloqueada pelo retorno ao conteúdo anterior,
nunca simplesmente por ser redução.

O HTTP direto continua evitando o cache da aplicação tradicional. Date, Age, recebimento,
fence, ordem local e ETag não certificam frescor. A ausência de sinais negativos permite
aceitação operacional, sem provar que os caches do provedor estejam atualizados.

## Persistência, histórico e proteção definitiva

São escritos somente atletas novos/alterados, com DECIMAL(38,18), tokens originais,
estados, participação e scouts. Linhas semanticamente idênticas não são reescritas.
O hash vigente representa a base efetiva, incluindo atletas preservados por omissão.
O hash observado representa separadamente a resposta recebida.

Inserções, alterações, revisão base+1, hash e deltas anterior/novo ficam na transação
de finalização existente. Resposta sem mudança efetiva não avança revisão, não altera
tokens/timestamps dos atletas e registra SEM_ALTERACAO. Não são criados snapshots completos.

UUID repetido reutiliza a coleta. Lease/fence são conferidos antes do commit. Retry
refaz a transação completa e não HTTP, com os limites anteriores: P2034 e P2010 somente
com MySQL 1213; tratamento restrito de P2002 na aquisição. Falha permanente não é mascarada.

A modalidade parcial rejeita qualquer coleta sobre pontuação já validada, inclusive
idêntica. Não muda VALIDADA para EM_REVISAO e não autoriza correção. O caminho forte
preexistente permanece com seu tratamento próprio de correção; não foi ativado ou ampliado.
Nenhum fluxo desta fase promove uma rodada para VALIDADA ou publica resultados.

## Validação executada

| Verificação atual | Resultado |
|---|---|
| Observação, estrutura/backfill e coletor diferencial | 9 suítes, 191 testes aprovados |
| Casos novos da modalidade PARCIAL | 20, incluídos no total acima |
| Regressão unitária Fantasy | 14 suítes, 322 testes aprovados |
| Prisma validate | Aprovado |
| Prisma generate | Aprovado, pelo build |
| Typecheck, lint e build | Aprovados |

Os totais se sobrepõem. Zero falhas/ignorados nas execuções finais selecionadas.
A suíte completa do repositório e integrações tradicionais fora do escopo não foram
executadas. A primeira execução encontrou erro TypeScript na tabela de casos de cache
do teste novo; a tipagem foi corrigida e todas as validações finais passaram.
Não foram usados resultados históricos como validação atual.

Cobertura nova: primeira carga, um/vários alterados, técnico novo, precisão decimal,
zero/negativo/nulo/ausente, redução legítima, idêntica, omissão e reaparecimento,
perda de campos/scouts, lista vazia, omissão ampla, A → B → A, cache, identidade,
mercado, contagem, revisão/deltas atômicos, UUID, concorrência, rollback, deadlock,
lease/fence e bloqueio de VALIDADA/EM_REVISAO. Os warnings de falha nos logs são cenários
deliberadamente injetados. Os testes anteriores não foram removidos ou enfraquecidos.

## Integridade e Git

As escritas ocorreram somente nos schemas isolados já ensaiados:

- A: `point_fantasy_observation_3b2_test_1792507380793`;
- B: `point_fantasy_observation_3b2_test_1792507380794`.

O coletor parcial foi testado no B; estrutura/backfill continuam exercitados em A/B.
Todas as respostas HTTP foram simuladas. Não houve coleta real, produção, migração,
backfill no principal ou exclusão de snapshots. Os testes mantêm dados sintéticos
somente nos schemas descartáveis.

O fingerprint de dados/DDL do principal permaneceu igual à referência preservada.
Estruturas A/B permaneceram iguais às do ensaio da 0029, incluindo constraints/índices/FKs.
Snapshot original de 275 atletas/técnicos, três coletas legadas, tabelas tradicionais
e histórico de migrations foram preservados. A divergência de proveniência de 0024/0025
continua aberta. A 0029 permanece sem aplicação no principal.

Evidências: `C:/Users/piter/AppData/Local/Temp/point-fantasy-3b33b3-SeomVS`, com manifesto
inicial, resultados/logs finais Jest, verificação de integridade e comparação final de arquivos.
A branch permanece a esperada, com quatro arquivos existentes modificados nesta fase e
este relatório novo, além de todas as alterações anteriores. Sem commit, push, merge ou deploy.

## Limitações e próximos passos

Não há garantia comprovada de que toda resposta aceita seja a mais recente do Cartola.
Identidade contextual não é transação atômica entre endpoints. Uma resposta antiga inédita
no histórico local pode passar. Uma correção legítima de retorno ao passado pode ser bloqueada.
Preservação de omissões mantém uma base parcial composta por observações em momentos diferentes.
Cache conservador pode recusar respostas válidas. Consulta histórica de hashes em JSON pode
exigir otimização futura conforme o volume, sem editar migrations anteriores.

Antes de ativação: revisar a política/limiar e os bloqueios sem override; definir operação
assistida de respostas suspeitas, política histórica e procedimento de correções; planejar
corte do escritor legado e sincronização do backfill; obter autorização posterior para
aplicação controlada da 0029 no principal e habilitação operacional, com backup e ensaio.
As barreiras de isolamento não foram removidas. Encerramento, validação definitiva,
rankings, cálculo de escalações e premiação permanecem fora desta fase.
