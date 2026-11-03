# Implantação local executada — 21/10/2026

Destino exclusivo: `127.0.0.1:3306/fantasy_point_do_jogador`.
Operador confirmado pelo usuário: `piterson\codexsandboxoffline`.
Branch: `feat/point-fantasy-scoring-observation-3b2`; alterações locais preservadas.

## Resultado

- 0029 e 0030 aplicadas nessa ordem pelo executor homologado, com os checksums
  aprovados, finished_at preenchido, logs nulos e applied_steps_count=1.
  Histórico anterior integralmente preservado, inclusive divergências 0024/0025.
- Backup disponível, hash íntegro e restauração homologada anteriormente.
  Plano, resultados e autorização conferidos contra a identidade real do servidor.
- Parada dos escritores comprovada por processos, serviços, tarefas agendadas,
  portas e ausência de outras conexões ao schema; não apenas pelos leases.
  Nenhum Node/Nest/PM2/container escritor nem mecanismo de reinício identificado
  entre 314 serviços e 220 tarefas. Verificação repetida antes de DDL e corte.
- Serviços existentes reutilizados para inicializar LEGADO, bloquear, executar
  backfill SQL e habilitar ATUAL no único escopo existente: **2026/31**.
- Controle final: **ATUAL, geração 2, fence 3, revisão atual 1**, sem pendências/leases.
  Três registros de auditoria de admissão com o operador confirmado.
- Backfill: **275 atletas, 20 técnicos**, soma DECIMAL exata
  `1169.590000000000001000`; coleta local 4, segunda execução reutilizada.
- **3 coletas originais, 1 snapshot e 275 atletas de snapshot preservados**.
  Comparação das 41 tabelas anteriores fora de apuração/coletas confirmou igualdade;
  nas coletas, as três linhas originais foram comparadas coluna a coluna por hash.
  Inscrições, escalações, rankings/pontuações tradicionais, carteira e PIX intactos.
- Nenhum HTTP ao Cartola, scheduler, acesso a produção/Render/outro banco,
  migration adicional, SQL manual para contornar admissão, commit/push/merge/deploy.

## Habilitação local restrita

`point-fantasy-local-maintenance.cjs` emite capacidades em memória para o
WriterAdmissionService e backfill existentes. Elas exigem aprovação do plano,
identidade do servidor, schema exato, operador, temporada/rodada, UUID da ação,
geração, fence, revisão/hash e drenagem. Cada transação revalida essas condições.
Objetos fabricados, produção, Render, destinos remotos ou outra operação são recusados.
O uso anterior dos schemas isolados permanece inalterado. Não há novo mecanismo
de persistência de pontuação; o CLI `point-fantasy-local-cutover.cjs` apenas coordena
os serviços existentes e registra a sequência executada.

Validação: 56 testes unitários aprovados, incluindo capacidades/recusas e regressões
de admissão/pontuação; banco inteiramente simulado nos testes desta implantação,
sem acessar schemas adicionais. Typecheck, build e Prisma validate aprovados.

## Primeira coleta HTTP ainda pendente

Arquivo preparado por `fantasy:collect:local prepare`, exclusivamente com leituras:

`C:/Users/piter/AppData/Local/Temp/point-ffc-local-preparation-Lcsrs1/first-collection-authorization.json`

UUID: `7a332af5-e9ae-49cb-8551-0a5d7102d3e7`.
Escopo: 2026/31; política partial-v1; operador preenchido; `approved: false`.
Validade inicial até 21/10/2026 11:14:04 em Brasília (14:14:04 UTC).
Após revisar e autorizar a primeira coleta, mudar `approved` para `true` e executar:

```powershell
npm.cmd run fantasy:collect:local -- 2026 31 7a332af5-e9ae-49cb-8551-0a5d7102d3e7 --authorization "C:\Users\piter\AppData\Local\Temp\point-ffc-local-preparation-Lcsrs1\first-collection-authorization.json"
```

Se expirar, gerar outro arquivo por `prepare` com o mesmo escopo/UUID e revisar a
nova autorização. O contexto atual do Cartola não foi consultado; o serviço existente
recusa a aplicação se a fonte não comprovar temporada/rodada solicitadas. partial-v1
não certifica frescor/completude ou pontuação final.

Evidências em `C:/Users/piter/AppData/Local/Temp/point-ffc-local-preparation-Lcsrs1`:
`local-deployment.log`, `local-deployment-verification.json`,
`local-cutover-authorization.json.execution.jsonl`, `local-cutover.log`,
`local-deployment-final.json` e `first-collection-prepare.log`.
