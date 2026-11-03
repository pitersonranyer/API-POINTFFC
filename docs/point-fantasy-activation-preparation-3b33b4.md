# POINT FFC Fantasy — preparação da ativação parcial, 3B.3.3B.4

Data: 20/10/2026. Branch: `feat/point-fantasy-scoring-observation-3b2`.

## Resultado e limites da entrega

A transição foi ensaiada em novas cópias locais anteriores à 0029. A ativação no
principal **não foi realizada nem está pronta para autorização irrestrita**: ainda faltam
o controle persistente de admissão dos escritores, o armazenamento de candidatos para
revisão administrativa e o procedimento definitivo de registro da execução nova da 0029.
Os ensaios comprovam os caminhos delimitados abaixo, não resolvem essas pendências.

Nenhum código de serviço, política partial-v1, migration, schema Prisma ou backfill
existente foi alterado. Não houve contato com Cartola, Render ou produção. O principal
foi usado somente para leitura de verificação. Nenhuma operação administrativa real foi habilitada.

Criados nesta fase:

- `scripts/point-fantasy-activation-rehearsal.cjs`: restaura backup verificável em novos
  schemas, executa testes de transição e ensaio de interrupção/retomada de DDL;
- `test/point-fantasy-activation.integration.spec.ts`: transição MySQL com fixtures HTTP;
- `test/point-fantasy-activation.spec.ts`: protocolo de admissão e decisões sem aplicação;
- `test/support/scoring-activation-model.ts`: modelos exclusivamente de teste, sem
  integração no serviço, persistência operacional ou autenticação real;
- este relatório.

O estado inicial do Git foi registrado com hashes de arquivos rastreados e não rastreados.
As alterações das fases anteriores foram integralmente preservadas, sem reset/clean/stash.

## Auditoria da partial-v1

| Critério atual | Efeito e risco | Recomendação |
|---|---|---|
| Temporada/rodada no mercado antes/depois, rodada do payload | Impede mistura detectável; não elimina cache coerente entre endpoints | Manter; histórico sem identidade suficiente não recebe exceção administrativa |
| `total_atletas` igual ao número recebido | Valida coerência interna, não completude | Manter sem transformar contagem em prova de lista completa |
| Age/Date suspeitos | Conservador; cache legítimo pode ser rejeitado | Manter inicialmente, registrar evidência e revisar com contrato da fonte |
| Pelo menos 50% de omissões | Pode bloquear toda a rodada mesmo quando os presentes são válidos | Tratar como limiar de triagem, não erro comprovado do provedor; não relaxar silenciosamente |
| Perda de campo/scout | Retém a resposta inteira, inclusive outras mudanças válidas | Manter inicialmente; aplicação por grupos de campos depende de regra explícita e novos testes |
| Conteúdo já observado/A → B → A | Bloqueia resposta antiga, mas também correção legítima e oscilações | Quarentena/revisão; hash repetido não significa necessariamente erro |
| Redução de pontuação | Permitida se não houver outra suspeita | Manter; crescimento não comprova frescor |
| Revisão validada | Bloqueia parciais em VALIDADA e EM_REVISAO com validação anterior | Manter sem override nesta modalidade |

O histórico consultado inclui respostas rejeitadas com hash observado: uma nova resposta
igual àquela pode continuar bloqueada indefinidamente. Repetir HTTP ou trocar UUID não
constitui procedimento de liberação. O limiar de 50% é particularmente sensível em bases
pequenas: a omissão de um atleta dentre dois já rejeita a coleta inteira.

Comparação das alternativas de omissão:

- Rejeitar toda a coleta conserva uma base transacional conhecida, mas retém alterações
  legítimas dos presentes. É o comportamento atual; existe log, não uma fila administrativa.
- Preservar omitidos e atualizar presentes aumenta disponibilidade, mas cria uma base de
  observações em momentos diferentes; pode aceitar uma lista truncada coerente com a contagem.
  Não é aceitável apresentar seu hash como hash de uma lista oficial completa.
- Quarentena integral conserva a base e permite decisão posterior, desde que o candidato
  seja retido de forma suficiente e vinculado à revisão/hash. É a opção recomendada para
  suspeitas relevantes no início da operação, ainda sem aplicação administrativa nesta entrega.

Para perda de campos, uma evolução pode preservar os grupos ausentes e aplicar grupos
independentes: pontos/estado/token devem ser indivisíveis; participação/estado/observação
também. Não se deve inventar independência entre pontos e scouts. Seria preciso registrar
valores recebidos, valores retidos e suas coletas de origem por grupo. A coluna atual
COLETA_ALTERACAO_ID identifica a última alteração da linha e, sozinha, não descreve toda
a proveniência de uma linha composta. A partial-v1 evita esse novo problema rejeitando
a resposta inteira com perda de informação.

Recomendação inicial: conservar partial-v1 enquanto não existir revisão assistida durável.
Não alterar o limiar nem adotar aplicação seletiva nesta fase. Uma futura partial-v2 deve
ser versionada, ensaiada e aprovada com exemplos reais documentados. A fonte continua sem
garantia comprovada de sequência/completude; uma resposta antiga inédita pode passar.

## Tratamento assistido proposto

Hoje o escritor ATUAL não guarda payload bruto. As rejeições guardam hashes, motivos,
IDs omitidos e estados retidos, mas não necessariamente os novos pontos/scouts. Portanto,
não é possível prometer comparação completa ou reaplicação de todas as coletas antigas.
Hash não recupera conteúdo. Para elas, a decisão segura é manter a base ou solicitar
nova observação, nunca reconstruir valores por suposição.

Antes de habilitar revisão real, registrar um candidato imutável e limitado aos dados
de pontuação necessários: campos normalizados recebidos, tokens exatos, estados,
omissões/retenções, diferenças contra a base, hash do payload, hash semântico, identidade,
normalizador e política. Sem autorização/cookies/campos pessoais arbitrários. Definir
retenção e tamanho máximo. Pode-se avaliar JSON existente da coleta para candidatos;
a decisão e sua trilha não devem sobrescrever silenciosamente a rejeição original.

Fluxo futuro, inicialmente por comando administrativo autenticado e restrito, sem endpoint público:

1. Consultar coleta/candidato e motivos, lista de atletas e comparação recebido/vigente.
2. Conferir identidade e integridade do payload mediante parser/normalizador, não booleans
   enviados pelo operador. Incompatibilidade de identidade ou payload inválido é irrecorrível
   por esta política; pedir outra observação. Revisão validada exige procedimento separado.
3. Vincular decisão a UUID, coleta candidata, temporada/rodada, revisão/hash da base,
   hash do candidato e versão da política. Identidade do responsável vem da autenticação,
   não de um campo livre. Exigir justificativa e registrar horário do banco.
4. Permitir inicialmente MANTER_BASE ou SOLICITAR_NOVA_OBSERVACAO. Solicitar não dispara
   HTTP dentro da transação; é uma operação posterior, expressamente admitida.
5. Qualquer futura aplicação assistida exige motivos de exceção enumerados e aprovados,
   não um `force=true`. Não pode ignorar identidade, integridade, lease/fence, base alterada
   ou proteção de pontuação validada. Aprovação administrativa não cria sequência oficial.
6. Na aplicação futura, adquirir o mesmo lock da apuração e verificar novamente todas as
   referências e autorizações dentro da transação. Base diferente invalida a decisão;
   recalcular comparação e obter nova decisão. Aplicar deltas/revisão/auditoria juntos.
7. UUID de decisão é único e persistente; repetição retorna o resultado original, e uso
   com conteúdo diferente falha. Preservar decisão original e eventuais decisões posteriores
   como eventos separados, sem apagar evidências.

O protótipo desta entrega está somente em `test/support`: ledger em memória, devolvendo
cópias das decisões e testando referências, justificativa, ator e idempotência. Aceita apenas
decisões que não aplicam pontuação. As flags de identidade/integridade são fixtures, não
validadores reais. Não oferece durabilidade, controle de acesso nem aplicação administrativa.
O armazenamento durável e o enquadramento dos eventos nos CHECKs da coleta precisam ser
definidos antes da próxima implementação; não usar SUCESSO/APLICADA para uma decisão sem revisão.

## Caminhos do escritor e corte

Caminhos encontrados no código local:

- `npm run fantasy:observe` → `scripts/point-fantasy-observe.cjs` → `ObservationService`
  compilado, com HTTP real se executado; não foi executado nesta fase;
- `ObservationModule` fornece o escritor legado, mas não está importado no AppModule;
- construção direta de `ObservationService` e `CurrentScoringService`, presente em testes;
- o diferencial não está registrado em módulo, endpoint, scheduler ou comando operacional.

Não foi inspecionado processo remoto nem Render. Estes caminhos são os encontrados no
repositório; inventário de processos/comandos externos é condição da futura operação.
O escritor legado aceita banco local e não possui uma barreira persistente de corte.
Lease compartilhado impede sobreposição ativa, mas não impede que o legado volte a
escrever depois. O diferencial detecta avanço do legado e bloqueia; isso é defesa,
não substituto para exclusividade de modelo.

Procedimento futuro por ambiente e conjunto explícito de temporadas/rodadas:

1. Aprovar artefato, operador, destino, política e janela. Registrar UUID do corte.
2. Bloquear novas admissões legadas em todos os processos e entradas, inclusive CLI,
   instâncias antigas e construção direta autorizada. Usar controle persistente comum,
   conferido sob lock na aquisição e finalização, ou isolamento efetivo de credenciais
   e processos; uma flag de ambiente ou arquivo local isolado é insuficiente.
3. Aguardar operações admitidas. Não migrar enquanto houver lease vivo. Após expiração
   confirmada pelo relógio do banco, recuperar sob lock: marcar operação interrompida,
   conservar evidências, invalidar fence e liberar somente a autorização correspondente.
   Registrar essa operação; não apenas limpar LOCK_TOKEN por SQL sem conferência.
4. Confirmar ausência de EM_ANDAMENTO e lease ativo no escopo; manter ambas admissões fechadas.
5. Obter backup consistente e verificar a restauração. Congelar DDL concorrente e observar
   os requisitos de consistência de todas as tabelas, inclusive as não transacionais se houver.
6. Executar somente a migration aprovada e validar sua estrutura antes de iniciar binário
   que usa o Prisma Client novo. O client atual conhece campos da 0029 e não é compatível
   com o banco anterior: o ensaio pré-DDL usou fixture SQL de atividade, não o client novo.
7. Com o legado ainda bloqueado, backfill escolhe a última coleta legada aceita por fence,
   não o maior ID/versão do snapshot. A → B → A pode reutilizar snapshot antigo legitimamente.
8. Conferir origem/destino exatos, contagem, técnicos, Decimal, tokens, estados, scouts,
   hashes, identidade, FKs, ausência de duplicidade e segunda execução sem alterações.
9. Gravar marco durável MIGRADA/BACKFILL_VERIFICADO e referências de origem. Se o legado
   avançar antes desse marco, não sobrescrever a nova base; abortar e replanejar sincronização.
10. Habilitar somente o escritor diferencial para o escopo autorizado, com limite inicial
    de operações, registro de resultados e capacidade de interromper novas admissões.

Os marcos são conceituais de operação, não novos estados da apuração implementados aqui.
O gate em memória dos testes verifica admissão/drenagem/repetição/pausa num processo.
Não impede outro processo de instanciar o legado e não foi integrado ao aplicativo.
Uma barreira persistente e seu ensaio concorrente entre processos são bloqueadores de ativação.

## Aplicação controlada da 0029

SHA-256 esperado da 0029:
`df2a5744867641f015ed6e28d447d66ffd705f589ec7c6f2c270d12f913e9c48`.
0028:
`d957effe85788abbf1a6df3b4035fe78ce66aad1071f8e7c58fe07cf3ccfb305`.

| Migration | Checksum histórico no banco | SQL local |
|---|---|---|
| 0024 | `01a5023fd78293a0a02cb38943e1066545c56031d9ec8650ca27174d69d349f4` | `3ad34fcd32e9f0c8de1b992d1dc4cf0842156bdb5ca1bdd31bb77e94c9411eb0` |
| 0025 | `d6514954e86ce2b5d2c8a3aa69225a72c3804fe9ca5271ef802c7c6195a65b1b` | `7fa6c71056791a429ecc57c9a33e4ff0cc84338f1f705a7f33266c294b1376e2` |

A divergência permanece aberta. O manifesto completo de 0001–0029 está nas evidências.
Não foram alterados checksums, migrations ou `_prisma_migrations`. O backup real conserva
os registros históricos originais; a reconstrução da fase anterior não recupera o SQL perdido.

Antes da futura aplicação: revisar conjunto exato de migrations, pendências/falhas e drift;
conferir novamente hashes e destino; registrar os arquivos sem commit como artefato imutável
com manifesto completo, versão do client/MySQL e autorização. Alteração do artefato invalida
a autorização. Preparar executor dedicado para executar **somente 0029**, sem deploy genérico.

O DDL é aditivo em dados, mas altera constraints e faz commits implícitos; o SQL inteiro
não é idempotente. Registrar início/fim/erro e cada instrução concluída. Em falha, examinar
metadados reais e prosseguir somente da fronteira comprovada, ou restaurar em nova base.
Nunca repetir cegamente a migration inteira nem presumir rollback global.

Os ensaios aplicam SQL bruto e deixam a história Prisma intacta, deliberadamente. Isso
**não equivale a uma migration 0029 registrada pelo Prisma**. Antes de aplicar no principal,
é obrigatório definir e ensaiar o registro legítimo dessa execução nova, com estado de falha
e conclusão verificáveis, sem reescrever 0024/0025 nem usar migrate resolve. Não há executor
operacional dessa etapa nesta entrega. Não iniciar `migrate deploy` depois do ensaio raw
como se a 0029 já constasse em `_prisma_migrations`.

## Recuperação por etapa

| Falha | Procedimento |
|---|---|
| Antes do DDL | Manter admissões fechadas, registrar falha. Reabrir legado somente se nenhum DDL/modelo novo foi aplicado e todas as pré-condições antigas continuam válidas |
| Durante DDL | Parar, preservar logs, verificar instruções/constraints realmente aplicadas; retomar fronteira comprovada ou restaurar backup em outro schema. Não assumir rollback |
| Durante backfill | Transação deve reverter linhas, auditoria e revisão. Verificar antes de repetir; gaps de AUTO_INCREMENT não são perda de integridade |
| Após backfill, sem coleta nova | Manter serviço parado e repetir verificações. Backfill só reutiliza a mesma origem/base exata; não recalcula por cima de revisão existente |
| Primeira coleta diferencial | Examinar UUID: terminal confirmado não se repete; erro transacional não confirmado exige verificar base e autorização antes de nova operação |
| Após várias revisões | Parar novas admissões e preferir avanço corretivo no modelo atual. Não apagar revisões/coletas ou reativar legado sem reconciliação |

Restaurar backup após revisões novas deve criar um destino separado e preservar o schema
com problemas, evidências e alterações tradicionais posteriores ao backup. Reconciliar o
intervalo e obter autorização específica antes de qualquer troca de destino. Restaurar
o banco inteiro por cima do principal poderia perder operações tradicionais e não faz
parte deste plano de execução. Snapshots legados não representam revisões diferenciais novas.

## Ensaios e verificações atuais

Foram criados novos schemas descartáveis a partir do backup real anterior à 0029,
com restauração comparada por fingerprints de dados/DDL e `_prisma_migrations` original.
O backup preservado corresponde integralmente ao principal atual pela verificação em leitura;
não foi obtido um backup novo do principal nesta fase. Sua restauração foi repetida agora.
Schemas anteriores de A/B, já com 0029, foram usados somente nas regressões existentes.

Cenário TRANSITION: atividade legada pré-DDL simulada por registros/lease SQL, fechamento
de admissão no modelo de teste, recusa de lease vivo, recuperação expirado e fence, aplicação
exata da 0029, escritor legado real pós-DDL em HTTP bloqueado, recusa de backfill concorrente
e LEASE_OCUPADO no diferencial sem HTTP; drenagem, backfill atualizado e idempotente,
primeira parcial idêntica, alteração diferencial, A → B → A rejeitado, falha após escrita,
rollback e recuperação com UUID novo. Backfill após revisão nova é recusado.

Uma trigger exclusivamente no schema de teste força falha da cópia após criação da auditoria
de backfill: linhas/auditoria/revisão foram revertidas. A trigger é removida ao final e não
existe nos artefatos operacionais. O ensaio não exige que AUTO_INCREMENT retroceda.

Cenário DDL_RECOVERY: interrupção após o primeiro ALTER TABLE confirma REVISAO_ATUAL
presente e tabela de atletas ainda ausente; retomada das instruções restantes produz
estrutura equivalente à 0029 completa. Isso ensaia parada entre instruções, não pane do
servidor no meio de uma instrução nem toda forma possível de falha de infraestrutura.

| Validação executada nesta fase | Resultado final |
|---|---|
| Novos testes de ativação/protocolo/revisão | 2 suítes, 20 testes aprovados |
| Observação/estrutura/backfill/coletor parcial | 9 suítes, 191 testes aprovados |
| Regressão unitária Fantasy | 15 suítes, 333 testes aprovados |
| Prisma validate/generate | Aprovados; generate pelo build |
| Typecheck, lint e build | Aprovados |

Totais se sobrepõem. Zero falhas/ignorados nas seleções finais. Não foi executada a suíte
completa do repositório, nem testes reais de produção/Cartola ou concorrência entre
processos operacionais. Resultados anteriores não foram usados como validação atual.

Falhas intermediárias: lint exigiu as anotações locais para importar helpers CommonJS,
seguindo o padrão existente; a primeira fixture de trigger falhou com MySQL 1295 porque
CREATE TRIGGER não passa pelo prepared statement do Prisma. Foi movida para o cliente
MySQL guardado por URL/schema isolado. O ensaio completo foi repetido em novas cópias,
sem enfraquecer as verificações. O log da falha foi preservado nas evidências.

Backfill real restaurado: 275 registros, 20 técnicos, soma decimal exata
`1169.590000000000001000`, segunda execução sem mudanças. Verificação SQL do backfill
compara tokens, estados, scouts, hashes e valores sem conversão dos pontos para Number.
Snapshots originais e colunas originais das três coletas legadas são comparados exatamente;
tabelas tradicionais e história permanecem intactas. O schema da fixture legada acrescenta
um snapshot sintético separado; o escritor diferencial não cria snapshots.

Evidências: `C:/Users/piter/AppData/Local/Temp/point-fantasy-3b33b4-7oezj8`.
`transition.json` identifica os dois schemas do ensaio final e seus resultados; inclui
manifesto, checksum do backup e pendência 0024/0025. Há logs/resultados Jest, integridade
das regressões, manifesto inicial/final. Cópias de ensaios anteriores também foram
retidas, sem exclusões. Nenhum resultado autoriza ativação no principal.

## Checklist para autorização futura

- [ ] Aprovar política inicial e impacto dos bloqueios, sem alegar frescor oficial.
- [ ] Definir retenção de candidatos e decisões administrativas duráveis/autenticadas.
- [ ] Implementar e ensaiar exclusividade persistente dos escritores entre processos,
      incluindo CLI antigo, reinício, perda de autorização e pausa de novas coletas.
- [ ] Identificar banco por host/porta/schema e identidade consultada no servidor; nada
      de fallback de DATABASE_URL ou flag genérica que remova as barreiras atuais.
- [ ] Aprovar manifesto imutável do artefato e documentar divergência 0024/0025 em aberto.
- [ ] Ensaiar executor restrito da 0029 e registro legítimo de sua execução/falha, sem
      alterar histórico anterior; definir como tratar qualquer migration pendente inesperada.
- [ ] Obter backup contemporâneo consistente e testar restauração antes da operação real.
- [ ] Drenar escritores, confirmar ausência de lease e executar backfill da última origem.
- [ ] Validar comparações exatas, idempotência, constraints/FKs e capacidade de recuperação.
- [ ] Autorizar explicitamente destino, escopo, operador, política e operações iniciais;
      configurar limite de execução e procedimento de interrupção.

O backend público não foi acessado. O principal continua sem 0029 e o coletor continua
bloqueado para ele. Nenhuma barreira de isolamento foi removida. Sem commit/push/merge/deploy.
