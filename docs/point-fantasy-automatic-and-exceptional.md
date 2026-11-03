# Coleta automática e correção excepcional local

Implementação desativada por padrão. Nada é registrado em AppModule; o processo de
automação cria um contexto Nest separado com ScheduleModule/SchedulerRegistry e o
mesmo CurrentScoringService. Não inicia schedulers tradicionais ou financeiros.
Destino único operacional: `127.0.0.1:3306/fantasy_point_do_jogador`.
Produção, Render, socket/query string, hosts remotos e outros schemas são recusados.

## Pré-condições e escopos novos

0029/0030 íntegras, estrutura homologada e escopo ATUAL com geração explicitamente
autorizada continuam obrigatórios. A automação não inicializa escopos nem escolhe
um modo de escritor. Um novo escopo vazio pode ser preparado pelo mecanismo
administrativo existente, sem SQL manual ou novas tabelas:

```powershell
$plano = "C:\Users\piter\AppData\Local\Temp\point-ffc-local-preparation-Lcsrs1\plan.json"
$escopo = "$env:TEMP\point-ffc-escopo32.json"
node scripts/point-fantasy-local-cutover.cjs prepare 2026 32 --plan $plano --authorization $escopo
```

O arquivo nasce com approved=false, writersStopped=false e operador vazio. Somente
após autorização, identificação do operador e comprovação da parada dos escritores,
preencher esses campos e executar `node scripts/point-fantasy-local-cutover.cjs $escopo`.
O serviço de admissão revalida estado, identidade, referências e drenagem em cada
transação. Escopo vazio dispensa backfill após verificação pelo próprio serviço;
havendo origem legada, mantém o backfill SQL exato e a prova de idempotência.
Esses comandos não foram executados no principal nesta implementação.

## Teste histórico local explícito

O modo normal coleta somente com `status_mercado=2` (fechado). Mercado aberto
produz `automation.skipped`, sem consulta de pontuações.

Para preparar o teste histórico, sem aprovar escrita:

```powershell
npm.cmd run fantasy:auto:local -- prepare 2026 31 "$env:TEMP\point-ffc-teste31.json" --historical-test
```

O campo `automation.historicalTest` seleciona exclusivamente o escopo autorizado,
independentemente do mercado. Ausente por padrão; produção e Render permanecem
bloqueados. Aprovação, operador e justificativa devem ser confirmados antes de
iniciar o mesmo CLI com o arquivo. O intervalo permanece 180000 ms; Ctrl+C encerra
o teste. A validação histórica e todas as proteções do coletor permanecem ativas.
Remover o campo ou usar um novo arquivo sem a opção restaura o modo normal.

## Iniciar e interromper automação

2026/32 é apenas exemplo da última rodada observada, não uma consulta atual ao Cartola.

```powershell
npm.cmd run build
$auto = "$env:TEMP\point-ffc-auto.json"
npm.cmd run fantasy:auto:local -- prepare 2026 32 $auto
```

Prepare faz somente leituras. Revisar o arquivo, preencher operator e reason,
confirmar as autorizações de escopo/geração e mudar approved para true. O arquivo
contém automation.intervalMs=180000 (3 minutos), automation.scopes, identidade do
servidor/schema, hashes e prazo de validade. O prazo inicial é de 30 minutos;
nenhuma aprovação com prazo superior a 24 horas é aceita.

```powershell
npm.cmd run fantasy:auto:local -- $auto
```

Primeiro tick após o intervalo. A cada tick o mercado oficial descobre temporada e
rodada; só um escopo presente na lista e ainda ATUAL/geração correta pode receber
uma autorização nova, vinculada a um UUID novo. Fora da lista, o tick registra recusa.
Há exclusão no processo e, entre processos, admissão transacional e lease/fence.
Sucesso, SEM_ALTERACAO, falhas HTTP/identidade e recusas são registrados em JSON;
operações admitidas também mantêm a coleta existente no banco. Falha não encerra
o timer; a próxima execução usa outro UUID.

**Parar:** Ctrl+C ou SIGTERM. O processo cancela novos ticks, aguarda a operação em
andamento e desconecta. Alterar approved para false impede novos ticks/HTTP na
próxima avaliação, mas não desfaz uma operação já admitida. Para revogação imediata
de escrita em andamento, o controle persistente de admissão continua sendo a barreira.
Mudanças de intervalo exigem reiniciar; aprovação/escopos/prazo são relidos em cada tick.

## Atualização administrativa de rodada não validada

```powershell
$uuid = [guid]::NewGuid().ToString()
$manual = "$env:TEMP\point-ffc-manual-$uuid.json"
npm.cmd run fantasy:collect:local -- prepare 2026 31 $uuid --authorization $manual
```

Preencher operator, reason (obrigatória no CLI) e approved=true após revisão.
Executar `npm.cmd run fantasy:collect:local -- 2026 31 $uuid --authorization $manual`.
Uma rodada encerrada, mas não validada, usa o mesmo fluxo parcial, normalizador e
UPSERT diferencial. Ausências preservam linhas existentes; omissão ampla, perda de
campos, cache suspeito e regressões continuam recusados. Não há fechamento implícito.

## Rodada validada: proposta e aplicação separadas

A coleta normal não altera a pontuação validada. Se a identidade for comprovada,
registra uma proposta com erro PARTIAL_VALIDATED_ROUND_BLOCKED na coleta existente:
payload oficial, alterações propostas, revisão/hash base, revisão validada, operador,
justificativa e respostas oficiais recebidas. O resultado continua REJEITADA e zero
alterações aplicadas. Inspecionar ALTERACOES e EVIDENCIA_ENCERRAMENTO dessa coleta.

Depois de revisar a proposta, preparar uma autorização administrativa específica:

```powershell
$aplicacao = [guid]::NewGuid().ToString()
$revisao = "$env:TEMP\point-ffc-revisao-$aplicacao.json"
npm.cmd run fantasy:collect:local -- prepare-review 2026 31 $aplicacao --authorization $revisao --review 123
```

Substituir 123 pelo ID real da proposta. O arquivo vincula ID, hash do payload e de
todas as evidências, revisão/hash base, revisão validada, servidor/schema/geração,
escopo e UUID novo. Preencher operador/justificativa e aprovar explicitamente.
Executar `npm.cmd run fantasy:collect:local -- 2026 31 $aplicacao --authorization $revisao`.

A aplicação reapresenta exatamente a observação oficial gravada, sem novo HTTP,
pelo mesmo coletor e normalizador. Não inventa certificado de frescor/completude.
Confere referências no início e na finalização; mudanças de base, evidências,
geração ou payload invalidam a autorização. Cache e demais regras permanecem.
Propostas repetidas do mesmo payload/base não se confundem com histórico aplicado;
outros conteúdos já observados continuam sujeitos à proteção de regressão.
Uma correção aprovada cria revisão nova e estado EM_REVISAO, preserva a revisão
validada anterior e a proposta original. O mesmo UUID é idempotente. Nenhum prêmio,
pagamento, ranking tradicional ou carteira é recalculado por esse fluxo.

## Identidade histórica e caso 2026/31

POINT FFC adota a premissa operacional aprovada de que o endpoint
`GET /atletas/pontuados/{rodada}` serve exclusivamente a temporada vigente.
Esta premissa de negocio nao e uma garantia formal do payload do Cartola.

O CurrentScoringService exige temporada solicitada igual a do mercado antes e
depois, contexto de mercado estavel e rodada compativel validada pelo normalizador.
O campo temporada pode estar ausente; se declarado, deve coincidir. Temporadas
anteriores sao rejeitadas mesmo quando declaradas pelo payload. Conteudo diferente
de snapshots anteriores pode ser atualizado, sujeito as demais protecoes existentes.

A evidencia historica registra o metodo POINT_FFC_CURRENT_SEASON_ENDPOINT_PREMISE,
a temporada solicitada e as temporadas observadas antes/depois. A premissa vale
para coleta administrativa e automatica pelo mesmo servico. Autorizacao operacional,
partial-v1, revisoes validadas, cache, lease, fence e geracao continuam obrigatorios.


