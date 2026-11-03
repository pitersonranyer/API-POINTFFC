# POINT FFC Fantasy — coletor diferencial, 3B.3.3B.1

Data: 20/10/2026. Branch: `feat/point-fantasy-scoring-observation-3b2`.

## Entrega e isolamento

Implementado `CurrentScoringService`, com persistência nas três tabelas da estrutura 0029.
Ele não está registrado em módulos, bootstrap, scheduler, endpoint ou comando de coleta.
Exige URL local de schema `point_fantasy_observation_3b2_test_<número>`, verifica DATABASE()
antes de escrever e recusa NODE_ENV=production. Não existe ativação no principal.

O fluxo de HTTP/identidade, aquisição exclusiva, UUID, lease/fence, retry, autorização final
e recuperação continua em `ObservationService`. Foram introduzidos pontos de extensão para
modelo de persistência, evidência leve e escrita diferencial. A implementação legada continua
selecionando SNAPSHOT_LEGADO por padrão e mantendo sua escrita de snapshots.

Cliente oficial, parser, normalizador, Decimal e helper de retry foram reutilizados sem alteração.
Não houve mudança no schema Prisma, nas migrations, no backfill ou nos fluxos tradicionais.

## Arquivos

Criados:

- `src/point-fantasy/observation/current-scoring.service.ts`;
- `src/point-fantasy/observation/current-scoring-plan.ts`;
- `src/point-fantasy/observation/current-scoring-policy.ts`;
- `test/point-fantasy-current-scoring.spec.ts`;
- `test/point-fantasy-current-scoring.integration.spec.ts`;
- este relatório.

Modificados sobre o estado inicial, preservando as alterações anteriores:

- `observation.service.ts`: pontos de extensão e metadados de resumo para o modelo ATUAL;
- `observation-errors.ts`: identificação das etapas CURRENT_READ, CURRENT_WRITE e REVISION_UPDATE;
- `scripts/point-fantasy-scoring-test.cjs`: inclusão das novas suítes e URL isolada específica.

Nenhum teste anterior foi removido, ignorado ou enfraquecido.

## Fluxo implementado

1. Validar parâmetros e alvo isolado antes de adquirir lease ou fazer HTTP.
2. Adquirir lock exclusivo da apuração e registrar coleta ATUAL, com UUID único e fence.
3. Repetição do mesmo UUID retorna a operação existente sem nova consulta; UUID de outro
   modelo é recusado como OPERATION_MODEL_CONFLICT.
4. Executar o mesmo fluxo de quatro respostas do coletor legado, fora da transação de escrita.
   Exigir temporada/rodada atuais coincidentes e mercado estável antes/depois, além do parser estrito.
5. Com lock, token, lease e fence conferidos, ler pontuação atual e calcular o plano diferencial.
6. Avaliar completude, ordem/frescor e eventual correção de pontuação validada.
7. Inserir novos atletas em lotes de 100; atualizar somente linhas alteradas, omitidas ou reaparecidas.
8. Gravar diferenças, revisão base/resultante e contadores na coleta; atualizar a revisão da apuração.
9. Confirmar tudo na mesma transação, cuja última escrita volta a verificar token/fence/lease no relógio DB.

O coletor novo não escreve em nenhuma tabela de snapshot. Os snapshots criados nos testes de
compatibilidade são fixtures do escritor legado, não resultado do novo escritor.

Também é recusada uma base inconsistente: atletas existentes com revisão da apuração zero ou
revisões de linhas superiores à revisão corrente. Se o escritor legado avançar depois da base
atual/backfill, a nova coleta é rejeitada com LEGACY_WRITER_ADVANCED_BACKFILL_REQUIRED.

## Política efetiva de completude e frescor

**Não foi inventada uma prova oficial a partir de cabeçalhos ou campos do payload.**
O código disponível não estabelece um contrato oficial suficiente para comprovar simultaneamente
completude e ordem das correções. Portanto, o verificador padrão retorna ausência de certificado.
Com ele, primeira carga, inclusões, alterações, omissões e reaparecimentos são rejeitados sem aplicar
pontuação. Uma consulta semanticamente idêntica à lista vigente pode ser registrada como SEM_ALTERACAO,
sem escrever nos atletas nem avançar revisão; suas limitações ficam explícitas.

A interface `ScoringEvidencePolicy` permite um futuro verificador revisado, síncrono e local.
Para permitir uma mudança, seu certificado deve:

- corresponder à temporada/rodada, hash do payload efetivamente recebido e hash da base atual;
- comprovar lista completa;
- fornecer fluxo de ordenação e sequência da fonte, estritamente superior à última aceita;
- comprovar que supera uma base sem ordem certificada, caso exista backfill/revisão anterior;
- aprovar explicitamente correção quando houver REVISAO_VALIDADA.

O certificado não vem de parâmetros HTTP de usuário ou flags de operação. A única implementação
que emite certificados nesta entrega está nas fixtures dos testes e chama-se `fixture-only-v1`.
Seus cabeçalhos artificiais não são critérios oficiais e não são interpretados pelo verificador padrão.
O mecanismo foi validado com essa autoridade simulada; isso não comprova evidência oficial disponível.

Sinais negativos adicionais:

- Age positivo ou inválido bloqueia mudanças;
- Date inválido ou posterior ao horário de recebimento bloqueia mudanças;
- Date regressivo em relação à última evidência certificada bloqueia mudanças;
- mercado alterado, rodada/temporada incompatível ou JSON inválido impedem aplicação;
- sequência antiga/igual ou mudança do fluxo de ordenação impede alteração.

Ausência de Age/Date e cabeçalhos aparentemente recentes não autorizam escrita. Horário de recebimento
e fence também não comprovam frescor. O controle de ordenação fica em
`LIMITACOES.evidenciaFonte.ordem`, vinculado à coleta aceita, sem novas colunas.
Consultas idênticas com sequência certificada mais nova podem avançar esse limite sem avançar a revisão.
Repetições antigas ou sem certificado não reduzem o limite de ordenação.

Sem prova suficiente, a coleta usa o estado disponível RESPOSTA_INVALIDA, resultado REJEITADA e código
como OFFICIAL_EVIDENCE_UNAVAILABLE, COMPLETENESS_UNPROVEN ou SOURCE_ORDER_NOT_NEWER.
Não é criada uma revisão pendente artificial. Valores existentes ficam preservados.

## Omissões, valores e revisões

Somente lista completa e com ordem/frescor certificados pode marcar uma omissão.
O atleta permanece na tabela, com PRESENTE_NA_ULTIMA_LISTA=false e seus últimos valores intactos.
Omissão não muda a participação observada para false nem zera pontuação. Reaparecimento é uma alteração
explícita, que volta a marcar presença e registra uma nova revisão.

Pontuação é Prisma.Decimal/DECIMAL(38,18). Não há conversão de pontuação para Number.
Zero, negativo, NULO e AUSENTE permanecem distintos. O mesmo vale para participação verdadeira/falsa/
desconhecida e scouts vazios/nulos/ausentes. Técnicos seguem o mesmo fluxo, inclusive posição 6.

Primeira carga aceita produz revisão 1; cada aplicação com mudanças produz exatamente base+1.
Consultas idênticas conservam revisão e linhas, inclusive tokens originais e ALTERADO_EM.
Mudança apenas de formatação numérica/ordem de scouts não reescreve atletas.
A → B → A produz revisões diferentes, mesmo que o hash do estado final volte a ser igual ao primeiro.

HASH_CONTEUDO do atleta conserva a semântica do normalizador. O hash da coleção vigente combina
identidade, hashes dos atletas, presença e versão de normalizador, incluindo os omitidos preservados.
No caso de consulta idêntica sobre backfill, conserva-se o hash já registrado, sem inventar revisão
apenas para trocar a representação do hash. A primeira mudança efetiva passa à representação atual.

Se houver REVISAO_VALIDADA, mudanças precisam de correção certificada, inclusive durante EM_REVISAO.
Uma alteração aceita a partir de VALIDADA muda o estado para EM_REVISAO e conserva revisão validada,
data e coleta de validação. Consulta idêntica não exige aprovar uma correção inexistente.
Não há fechamento automático ou caminho de código que promova a rodada a VALIDADA.

## Histórico leve

Coletas novas têm MODELO_PERSISTENCIA=ATUAL e SNAPSHOT_ID nulo. Guardam fonte, recebimento, hashes,
revisão base/resultante, resultado e contadores de recebidos/inseridos/alterados/omitidos.
Hash do payload identifica bytes observados; o hash de conteúdo de um sucesso identifica o estado
vigente resultante. `LIMITACOES.hashObservado` preserva o hash normalizado da resposta recebida.

ALTERACOES contém apenas IDs modificados, tipo, revisão, hashes anterior/novo e campos anteriores/novos
relevantes. Campos de valor incluem seus estados. Decimais e tokens são strings exatas.
Omissão registra apenas presença; não duplica a pontuação que foi conservada.
Na primeira carga, todos os registros são inclusões e por isso aparecem no delta; consultas
posteriores não copiam linhas inalteradas nem produzem snapshots completos de cada versão.

Não se guarda PAYLOAD_RECEBIDO novo. Evidências de mercado/partidas são resumos e hashes, sem corpos
integrais. Somente cabeçalhos de cache permitidos são retidos. Authorization, cookies e campos
arbitrários das respostas não entram na auditoria. Os payloads e coletas legados não são alterados.

## Concorrência e recuperação

O mesmo mecanismo da 3B.3.3A.3 protege ambos os escritores: lock da apuração antes dos filhos,
lease DB, UUID, fence e quatro tentativas transacionais no máximo. P2010 só é repetido como deadlock
com MySQL 1213; chamadas HTTP e normalização não são repetidas por retry de persistência.
Cada repetição refaz o plano e verifica a base/autorização. Não há renovação automática do lease.

Rollback inclui inserções, atualizações, omissões, revisão, hashes e delta. Operação terminal
confirmada vence uma perda de confirmação do commit. Trabalhador atrasado não pode sobrescrever
a revisão do trabalhador que assumiu uma nova autorização.

## Validação atual

Schemas reutilizados:

- A: `point_fantasy_observation_3b2_test_1792507380793`;
- B: `point_fantasy_observation_3b2_test_1792507380794`.

As estruturas reais foram lidas antes da implementação, incluindo CHECKs, tipos, índices e FKs.
Não houve aplicação de migration nesta fase. O novo coletor foi exercitado no B; estrutura/backfill
continuaram sendo testados em A e B. Toda resposta da API nos testes foi simulada.

| Verificação executada | Resultado |
|---|---|
| Observação + estrutura/backfill + novo coletor | 9 suítes, **169 testes aprovados** |
| Novos testes | 16 unitários e 25 integrações, incluídos no total acima |
| Regressão unitária POINT Fantasy | 14 suítes, **320 testes aprovados** |
| Falhas / ignorados nas execuções selecionadas | Zero / zero |
| Prisma validate e generate | Aprovados; generate executado pelo build |
| Typecheck, lint e build | Aprovados |

Os totais se sobrepõem e não devem ser somados. A suíte completa do repositório e integrações
tradicionais de escalações não foram executadas; estas foram excluídas da regressão unitária.
Nenhum resultado histórico foi contado como execução atual.

Cobertura inclui primeira carga, repetição, um/vários alterados, atleta/técnico novo, omissão,
reaparecimento, A → B → A, precisão e estados, temporadas separadas, UUID, concorrência,
lease/fence perdidos, trabalhador atrasado, rollback entre lotes e após alterações de linhas,
deadlock, commit sem confirmação, mercado alterado, histórico sem temporada, resposta incompleta,
payload antigo com fence válido, cache, revisão validada e correção certificada.

Evidências: `C:/Users/piter/AppData/Local/Temp/point-fantasy-3b33b1-ADkcGe`.
Incluem manifesto inicial, estruturas reais A/B, logs/resultados JSON de testes e integridade.
O runner também verifica os fingerprints de dados/DDL do principal, histórico/tabelas tradicionais
dos testes, snapshot original com 275 registros e as três coletas legadas. Todos permaneceram intactos.

## Limitações e preparação para 3B.3.3B.2

1. Aprovar e implementar um verificador real de completude e ordem/frescor. O padrão conservador
   não permite mudanças reais; o verificador das fixtures não deve ser usado como evidência oficial.
2. Definir a identidade histórica comprovável: a rota numerada, sozinha, continua pendente.
   Nem mesmo um certificado de frescor contorna o bloqueio de identidade do fluxo compartilhado.
3. Planejar o corte entre escritores e a base de backfill. Se o legado avançar após a inicialização,
   a operação é recusada; não há sobrescrita ou rebase automático.
4. Manter a política oficial de encerramento em fase própria. Estabilidade, mercado, partidas,
   participação ou ausência em lista não validam automaticamente uma rodada.
5. Antes de qualquer uso no principal: aprovação posterior, aplicação controlada da 0029,
   backup/restauração, revisão do histórico e ensaio dos artefatos finais. A divergência de
   proveniência de 0024/0025 permanece aberta.
6. Planejar limites operacionais para lotes grandes dentro da transação/lease e consumo de revisões
   consistentes pelo motor futuro. Esta entrega não calcula escalações ou rankings.

O estado final mantém as alterações sem commit das fases anteriores. Somente os três arquivos
existentes listados acima foram modificados nesta fase; seis arquivos foram criados.
Não houve alteração do principal, produção, migrations, coleta real, commit, push, merge ou deploy.
