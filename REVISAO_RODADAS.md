# Processamento das rodadas

## Diagnóstico e decisões antes da implementação

O backend NestJS usa Prisma/MySQL, snapshots imutáveis em TimeRodada, pontuação
única por snapshot, cache de pontuados em memória/Redis e ranking por SQL.
Não havia scheduler nem estado persistente da rodada. A atualização anterior
recriava snapshots históricos; parciais e substituições podiam sobrescrever-se.

Preservar as tabelas e as chaves existentes. Adicionar controle de processamento,
dados oficiais da rodada e metadados de desempate à escalação. Não executar
migrations antigas, reset, limpeza de dados ou alterações na autenticação.

## Regras e limites da fonte externa

Fontes oficiais consultadas em 04/09/2026:
- https://ge.globo.com/cartola/tutoriais/noticia/2022/03/09/cartola-2022-reserva-que-negativar-nao-sera-acionado-pelo-banco-entenda.ghtml
- https://ge.globo.com/cartola/tutoriais/noticia/2025/03/12/o-que-e-e-como-funciona-o-reserva-de-luxo-no-cartola-entenda.ghtml

Reserva normal exige ausência confirmada, participação do reserva e pontos
positivos. Prioridade cronológica; empates: capitão, preço e nome. Luxo exige
participação de todos os titulares da posição e pontuação estritamente superior
ao menor titular, antes do multiplicador; aceita pontos negativos. O substituto
do capitão herda a braçadeira. Técnico não tem reserva.

Ausência em pontuados não comprova ausência em campo. A implementação deve
exigir entrou_em_campo explícito e partida encerrada. Dados desconhecidos
permanecem pendentes; na conciliação não podem produzir um resultado definitivo
inventado. Falta de preço/nome em desempate também impede decisão definitiva.
Não inferir fim de partida apenas pelo horário ou placar. O contrato de término
aceito precisa ser documentado e testado; status desconhecido mantém pendência.

O endpoint de substituições existente não identifica temporada/rodada e não é
adequado para reconstruir histórico. O fluxo novo deve usar informações globais
e a escalação congelada, sem download por time durante a pontuação.

### Verificação do contrato real (05/09/2026)

Consultas públicas de leitura confirmaram temporada=2026, rodada_atual=26 e
mercado aberto. `/partidas/25` identifica a rodada, mas devolve os campos de
transmissão/período vazios nos dez jogos históricos. `/atletas/pontuados/25`
retornou 332 atletas, todos com participação explícita, dos quais três com
`entrou_em_campo=false`. Isso não comprova que atletas ausentes do envelope não
jogaram. Essa ausência continua desconhecida e pode impedir a consolidação.

Na conciliação, a reabertura verificada da rodada seguinte é evidência adicional
de encerramento: permite avaliar jogos válidos com horário passado mesmo quando
o Cartola já limpou o período de transmissão. Durante mercado fechado, período
desconhecido não autoriza substituição. Para o estado de espera, bola parada e
nenhum jogo válido futuro são suficientes; isso não torna a pontuação definitiva.

## Relatório de entrega

1. **Arquitetura encontrada:** NestJS, Prisma 5/MySQL, CartolaService como
   integração HTTP, snapshots em TimeRodada/EscalacaoTimeRodada, cache global
   Redis/memória e ranking SQL sobre pontuações persistidas. Não há modelo de
   ligas/inscrições neste repositório.
2. **Problemas corrigidos:** ausência de scheduler/estado recuperável; criação de
   snapshots históricos na atualização anterior; consultas externas antes de
   verificar snapshot existente; cálculos concorrentes de parcial/substituição;
   perda da braçadeira no substituto; ausência de armazenamento final da rodada.
3. **Arquivos de produção:** `src/round-processing/{round-processing.service,
   round-processing.module,round-calculator}.ts` (novos), `src/app.module.ts`,
   `src/cartola/{cartola.service,cartola.controller,cartola.types}.ts`,
   `src/cartola/dto/season-query.dto.ts` (novo),
   `src/config/environment.validation.ts`, `.env.example`,
   `src/time-snapshots/time-snapshots.service.ts`,
   `src/partial-score/partial-score.service.ts`,
   `src/substitutions/substitution.service.ts`,
   `src/parciais/{parciais.service,parciais.module,parciais.controller}.ts`,
   `src/parciais/dto/atualizar-rodada-anterior.dto.ts`, `prisma/schema.prisma`.
   Testes novos: `test/round-{calculator,history,processing.service}.spec.ts`.
   Testes existentes de snapshot, parcial, substituição e atualização anterior
   foram adaptados ao contrato de leitura e processamento centralizado.
4. **Prisma:** novo RodadaProcessamento com chave temporada/rodada, estados,
   conjunto de times previstos, falhas, envelopes de atletas/partidas, erro,
   lease e data de consolidação. Escalação ganhou ordem, preço e nome para
   reprodução/desempate. Pontuação ganhou consolidadoEm. Substituição ganhou
   ativa. Mantidos os enums PARCIAL/FINAL da pontuação: FINAL equivale a
   consolidada, preservando o contrato existente.
5. **Migration:** `prisma/migrations/0009_round_processing/migration.sql`, somente
   CREATE/ALTER aditivos. Criada e validada com geração do cliente/build; **não
   aplicada ao banco**. Nenhuma migration antiga foi editada ou executada.
6. **Fechamento:** scheduler lê status fresco. Estado 2 permite captura;
   registro persistido ausente/incompleto aciona recuperação mesmo sem observar
   a transição em memória. Estados diferentes de 1/2 não processam pontuação.
7. **Snapshot:** TimeSnapshotsService valida temporada/rodada e mercado fechado
   antes e depois do download. Usa getTeamById fresh com rodada explícita,
   persiste composição em transação e conserva registros completos existentes.
   Registro vazio pode ser completado enquanto o mercado ainda está fechado.
8. **Times selecionados:** união deduplicada dos TimeUsuario e TimeRodada da
   temporada/rodada; conjunto previsto fica congelado na primeira criação do
   processamento. Novos vínculos após essa seleção não alteram retroativamente
   a obrigação de captura. Snapshots adicionais existentes entram no cálculo.
9. **Duplicidade:** preservadas as chaves únicas de time/temporada/rodada,
   atleta/snapshot, pontuação/snapshot e par de substituição. Upserts e lotes
   atualizam as mesmas linhas. Consultas não persistem pontuação.
10. **Falhas de captura:** lotes de cinco com allSettled; grava time/erro e
    retenta somente ausentes. Times capturados podem pontuar; snapshot geral
    continua pendente. Não baixa escalação depois da reabertura para remediar
    captura perdida.
11. **Reinício:** times previstos, falhas, último envelope, etapa e lease estão
    no MySQL. Reinício retoma captura, cálculo incremental ou conciliação.
    Lease expirada pode ser adquirida por outra instância.
12. **Titulares:** flags originais permanecem na EscalacaoTimeRodada; a escalação
    efetiva é montada separadamente em memória, sem modificar a base.
13. **Capitão:** ID e flag originais; multiplicador decimal 1,5 em positivos e
    negativos. Substituto herda a braçadeira do titular efetivamente substituído.
14. **Reservas:** ID, posição, clube, ordem recebida, preço e nome persistidos;
    reserva não entra na soma sem troca efetiva e não pode ser reutilizado.
15. **Reserva de luxo:** reservaLuxoId preservado. Regra centralizada no
    round-calculator, aplicada antes da soma e reavaliada na conciliação.
16. **Técnico:** pontuação entra como titular; não há substituição de técnico.
17. **Liberação:** termina a tentativa de captura do lote geral antes de buscar
    o envelope global. Só snapshots com titulares entram no processamento.
    Endpoint de pontuados aguarda o envelope publicado pelo processador.
18. **Pontuação:** Map por atleta, escalação efetiva, capitão e arredondamento
    Decimal para duas casas. Uma leitura externa atende a todos os times.
19. **Incremental:** compara atletas e eventos relevantes das partidas; carrega
    escalações afetadas via relações indexadas por atleta/clube, além de times
    ainda sem pontuação. Escrita de pontos em lotes de 100, sem N+1 por time.
20. **Substituições:** regras nas fontes acima. Avalia encerramento, alteração
    de participação, primeiro cálculo e conciliação; mudanças de placar,
    cronômetro ou scout isolado não reavaliam as regras. Fim já observado é
    preservado quando a API limpa o campo. Trocas antigas ficam inativas,
    sem exclusão física. Empate sem metadados suficientes fica pendente.
21. **Fim dos jogos:** bola_rolando=false e jogos válidos sem horário futuro
    permitem AGUARDANDO_CONSOLIDACAO. Período F é evidência explícita usada
    durante as parciais. Horário desconhecido mantém a espera por evidência.
22. **Reabertura:** somente status 1; procura pendências persistidas e valida
    temporada/rodada contra a janela oficial. Manutenção não consolida.
23. **Conciliação:** leitura fresca final de atletas/partidas, validação,
    recálculo de todos os snapshots e publicação numa única transação. Pontos,
    trocas, envelopes e status final são confirmados juntos. Falha mantém o
    último resultado e registra erro para nova tentativa.
24. **Snapshot reutilizado:** conciliação não chama criarSnapshot/getTeamById;
    usa somente composição persistida. Testes verificam a contagem de downloads.
25. **Banco oficial:** envelopes históricos permanecem em MySQL, incluindo
    scouts, participação e metadados recebidos. Não existe cadastro de atletas
    normalizado no modelo original; não foi criado cadastro duplicado.
26. **Endpoints:** `/cartola/atletas/pontuados/:rodada` e
    `/cartola/partidas/:rodada` usam o banco quando consolidados, inclusive sem
    consulta de status do mercado. Aceitam `?temporada=2026`; sem temporada,
    usam a última temporada persistida. `/parciais` e `/ranking-geral` continuam
    lendo pontuações do banco. Serviços de detalhes leem em RepeatableRead.
    POST `/parciais/atualizar-rodada-anterior` agora concilia pendência existente
    e não reconstrói escalação histórica.
27. **Concorrência:** lease por rodada de 120 segundos, renovada entre lotes;
    token verificado dentro da transação final, com lock da linha, impede
    publicação por worker que perdeu a lease. Chamadas concorrentes de status
    compartilham a requisição em andamento. Scheduler único por processo,
    automático, com intervalo de 20 segundos com bola rolando e 60 nos demais
    estados; `ROUND_PROCESSING_ENABLED=false` desativa sua execução.
28. **Testes:** suíte local e cenários simulados de 5.000 times; resultados finais
    registrados abaixo. Testes externos MySQL/Redis permaneceram desativados.
29. **Validação técnica:** geração Prisma, TypeScript, lint, build e diff-check;
    resultados finais registrados abaixo.
30. **Limitações:** a API não comprova participação dos atletas omitidos;
    nesses casos a conciliação fica pendente, em vez de inventar um resultado.
    Contrato de término ao vivo diferente de F exige adaptar o normalizador.
    Não houve validação de carga em MySQL real. Não há ligas persistidas a
    atualizar; o ranking existente reflete imediatamente os pontos da mesma
    transação, sem recalcular times no GET. Snapshots legados não ganham
    retroativamente comprovação do instante de captura. Reconsolidação
    administrativa está disponível como serviço, sem tela/endpoint novo, e
    rejeita temporadas/rodadas fora da janela comprovada pela API atual.

## Implantação

Aplicar somente a migration nova após conferir o histórico do ambiente. Não
executar reset ou reaplicar migrations antigas de recriação. Gerar o cliente,
publicar o backend e manter o processo ativo antes do próximo fechamento.
Nenhum banco foi resetado, nenhum dado foi removido e autenticação, Firebase
e frontend não foram alterados.

## Resultado das verificações (05/09/2026)

- `npm.cmd test -- --runInBand --silent`: 21 suítes aprovadas, 179 testes
  aprovados; 5 suítes/7 testes externos desativados.
- Regressão específica de histórico após o último ajuste: 4 testes aprovados.
- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd run build`: aprovado, incluindo geração Prisma.
- `git diff --check`: aprovado.
- Simulação de 5.000 times: um envelope global, 50 lotes de escrita de pontos
  e quatro consultas de times; não representa benchmark de MySQL em produção.
