# Sincronizacao automatica dos Desafios

No Render, configurar `DESAFIOS_SYNC_SCHEDULER_ENABLED=true` e o token existente
`FOOTBALL_DATA_API_TOKEN`. A flag e independente de `FUTEBOL_SYNC_SCHEDULER_ENABLED`.
Nao exige migration. O processo Nest precisa permanecer ativo para executar cron.

O scheduler roda a cada cinco minutos, sem consulta no bootstrap. Seleciona somente
Desafios publicados, nao cancelados, com partidas pendentes. Comeca a consultar
15 minutos antes do horario previsto. Partidas pendentes com inicio ha mais de seis
horas sao consultadas no maximo uma vez por hora; as demais, a cada cinco minutos.
O campo `atualizadoEm` da partida serve como referencia da ultima persistencia.
Partidas finalizadas/anuladas nunca entram no lote automatico novamente. Correcoes
posteriores continuam disponiveis pela apuracao administrativa manual.

Antes de qualquer chamada externa, o scheduler busca FUTEBOL_PARTIDA em lote por
externalId, incluindo competicao e equipes. Reutiliza somente registros cuja
identidade externa coincide com todos os snapshots envolvidos. IN_PLAY/PAUSED
exigem ultimaAtualizacaoApi de no maximo dez minutos e ambos os gols inteiros
validos. SCHEDULED/TIMED e status de anulacao exigem ultimaAtualizacaoApi de no
maximo 15 minutos. Datas futuras, status desconhecidos e identidade divergente
exigem fallback. atualizadoEm da tabela Futebol e ultimoSyncEm da competicao nao
comprovam recencia do fornecedor; nao sao usados como substitutos de lastUpdated.
Essa politica e conservadora: mesmo uma consulta recente pode trazer lastUpdated
antigo e exigir fallback. O campo atualizadoEm de DESAFIO_PARTIDA continua servindo
apenas para controlar o intervalo entre persistencias do scheduler.
Para evitar regressao de uma parcial, uma observacao interna anterior a ultima
persistencia de uma DESAFIO_PARTIDA EM_ANDAMENTO tambem exige fallback. Essa
persistencia e somente um limite conservador; nao e tratada como lastUpdated.

O placar interno IN_PLAY/PAUSED e uma parcial fullTime do fornecedor, nunca prova
de placar final regulamentar. EXTRA_TIME/PENALTY_SHOOTOUT exigem fallback para
obter regularTime. FINISHED interno sempre exige fallback porque o schema atual
descarta duration e regularTime. O mapper regulamentar existente confirma o final
externo antes da apuracao. Uma vez confirmada em DESAFIO_PARTIDA, a partida sai
das consultas automaticas. Nenhuma fonte Cartola participa desse fluxo.

IDs compartilhados sao deduplicados entre Desafios. O cliente football-data.org
existente divide consultas em lotes de ate 50 e espaça chamadas em 6,5 segundos.
Com F IDs que exigem fallback, o custo por ciclo e `ceil(F / 50)` chamadas;
com todos os dados internos suficientes, zero. Ate 50 partidas simultaneas sem
dados internos suficientes custam no maximo aproximadamente 12 chamadas por hora, por
instancia, alem das consultas de outras funcionalidades. Pendencias antigas,
ate 50 IDs, custam aproximadamente uma chamada por hora. Instancias distintas
podem consultar o mesmo lote; o limitador de API e local a cada processo. Para
preservar esse orcamento, habilitar o scheduler em uma unica instancia.

Placares parciais nunca definem resultado nem pontuam palpites. Durante prorrogacao
ou penaltis, somente `regularTime` pode alimentar o placar regulamentar. FINISHED
sem placar regulamentar seguro continua pendente. Resultados finais e anulacoes
reutilizam a transacao da apuracao manual, com SELECT FOR UPDATE e verificacao do
snapshot obtido antes da consulta. Uma execucao concorrente com snapshot obsoleto
e rejeitada e tentada no proximo ciclo; pontos sao atribuidos de forma absoluta.
Os pontos continuam persistidos por palpite/inscricao, sem movimentar carteira.

Falhas de API preservam as partidas sem resposta, mas nao impedem persistir os
resultados internos confiaveis, inclusive no mesmo Desafio. Timeout/rede/falha interna aguardam cinco
minutos; rate limit, token ausente ou acesso negado aguardam 15 minutos. Respostas
incompletas deixam os IDs ausentes pendentes; dados disponiveis continuam sendo
processados. O backoff bloqueia apenas chamadas externas, nao consultas internas.
Logs `desafios.sync.sources`, `desafios.sync.pending`, `desafios.sync.ok`, `desafios.sync.skipped` e
`desafios.sync.failed` informam contagens, pendencias e proxima tentativa sem
registrar credenciais ou erros brutos do banco.

Os testes locais usam API/banco simulados e cobrem parciais, finais, empate,
anulacao, multiplas inscricoes, deduplicacao, filtros de horario, flag independente,
falhas temporarias, resposta incompleta, identidade divergente, rollback e
concorrencia com scheduler/manual. Nenhuma apuracao real e executada.

## Necessidade futura de migration

A menor extensao segura da sincronizacao geral requer campos novos para
score.duration e score.regularTime.home/away em FUTEBOL_PARTIDA (ou um resultado
regulamentar normalizado equivalente). Isso exige migration e alteracao conjunta
do mapMatch e da persistencia geral. Nenhuma migration foi criada/aplicada nesta
etapa, nem foram inventados esses campos no payload interno. Registros antigos
devem continuar usando fallback ate obter confirmacao. Com os campos persistidos,
o mesmo mapDesafioResultado podera validar resultados internos finais, inclusive
empates apos prorrogacao/penaltis, reduzindo tambem as consultas finais adicionais.
