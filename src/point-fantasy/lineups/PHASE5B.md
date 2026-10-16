# Fase 5B — identidade pública

Atualização 5B.3: a migration 0026 e os testes MySQL foram executados no banco
local expressamente autorizado. O bloqueio descrito nas seções históricas 5B/5B.1
foi resolvido. Consulte o resultado da fase 5B.3 ao final deste documento.

## Arquitetura e auditoria

Branch de trabalho: `codex/point-fantasy-team-identity-phase5b`, inicialmente limpa.
O fluxo existente é NestJS + Prisma 5/MySQL. `LineupController` exige JWT e
obtém `Usuario.idUsuario` pelo decorator de autenticação. `LineupService` valida
usuário ativo, propriedade, competição, catálogo, atletas, janela de edição e
versão. Todas as operações usam transações `Serializable`; conflitos Prisma
P2002/P2025/P2034 viram HTTP 409. A fase estende esses mesmos serviços e rotas.
Nenhum serviço financeiro, inscrição confirmada ou ranking foi modificado.

## Banco e migration

`0026_point_fantasy_team_identity` é aditiva, sem backfill, exclusões ou renomeações.
Foi gerada por comparação dos schemas, sem conexão ao banco.

- `FantasyTimeIdentidade`: proprietário, competição, nome-base, identificador
  aleatório de 7 caracteres (alfabeto de 32 símbolos), contador e timestamps de auditoria.
  Unicidade por usuário/competição e unicidade global do identificador público.
- `FantasyEscalacao`: identidade, sequencial e nome público opcionais para
  compatibilidade. Unicidade por identidade/sequencial e competição/nome público.
  FK composta garante que identidade, proprietário e competição correspondam.
- `FantasyTimeOperacao`: chave de idempotência, hash dos parâmetros normalizados,
  ID do resultado e timestamp. Chave única por identidade. O registro permanece
  após excluir o rascunho; o ID do resultado é histórico, sem FK para o rascunho.

Identidade, incremento do contador, rascunho, atletas e registro de idempotência
são gravados na mesma transação. Falhas revertem tudo. O contador persistido nunca
é calculado pela quantidade de rascunhos. Concorrência pode retornar 409. Apenas
colisões do código público na criação da identidade têm até cinco tentativas
transacionais automáticas, mantendo o nome-base e os parâmetros originais.
As restrições únicas e o isolamento protegem os dois primeiros salvamentos,
criações e duplicações concorrentes.

Não foi identificada `POINT_FANTASY_TEST_DATABASE_URL` local: migration não
aplicada. Revisar o SQL e aplicar pelo processo habitual de migrations antes de
iniciar a versão nova da API. Não usar reset, db push ou seeds destrutivos.
Os testes MySQL existentes aceitam somente localhost/127.0.0.1 e banco
`point_fantasy_lineups_2a_test_*`. Preparar esse banco descartável com migrations
e informar a variável para executar `npm test -- --runInBand point-fantasy-lineup.integration`.

## Contrato e integração frontend

As rotas e os campos anteriores continuam válidos.

1. Consultar `GET /point-fantasy/competicoes/:id/escalacoes/minhas`.
   Campos adicionais: `identidade` (objeto ou null), `estadoIdentidade`
   (`NOVO`, `LEGADO`, `DEFINIDA`) e `rascunhosLegados` (contagem total, sem depender
   da página). Identidade contém somente `nomeBase`, `identificadorPublico` e
   `ultimoSequencial`; não expõe IDs internos de usuário ou identidade.
2. No primeiro `POST /point-fantasy/competicoes/:id/escalacoes`, enviar
   `nomeBase` junto da formação/seleção. Exemplo:
   `{"formacao":"4-3-3","nomeBase":"Tropa do Mago","chaveIdempotencia":"draft-001"}`.
   Por compatibilidade, ausência de nome cria `Meu Time`. Não se cria identidade
   apenas ao consultar, abrir a tela ou editar um rascunho legado.
3. Nos próximos POSTs, omitir `nomeBase`. Um nome diferente retorna 409;
   repetir o mesmo nome normalizado é permitido. PATCH continua aceitando apenas
   versão e seleção e rejeita campos de identidade.
4. `POST /point-fantasy/escalacoes/:id/duplicar` continua recebendo `versao`,
   com `nomeBase` e `chaveIdempotencia` opcionais. A duplicação de um legado pode
   definir a identidade se ela ainda não existir; o original não muda.
5. Toda resposta de escalação inclui `nomePublico`, `sequencial`, `legado` e
   `identidade`. Exibir `nomePublico` retornado, sem construir números no cliente.
   Exemplo de formato: `#K7P42AB · Tropa do Mago 01`. O identificador
   público é aleatório e não deriva de IDs internos. Sequenciais acima de 99
   continuam crescendo (100, 101 etc.).
6. Reutilizar a mesma `chaveIdempotencia` e os mesmos parâmetros em retries;
   gerar outra chave somente para uma nova intenção de criar/duplicar.
   Formato: 1–100 caracteres ASCII alfanuméricos, `_` ou `-`.
   Chave igual com parâmetros diferentes retorna 409. Replay devolve o rascunho
   atual, sem alocar outro sequencial; se já excluído, retorna 409.
   Sem chave, cada POST é uma nova criação, preservando o comportamento anterior.
   Duplicações ainda exigem fonte existente e versão atual. Após 409 concorrente,
   repetir os parâmetros e a chave; após conflito de versão, recarregar a fonte.

Nomes: NFC, remoção de espaços externos, compactação de espaços ASCII internos,
2–60 caracteres Unicode; letras/números na primeira posição; letras, marcas de
acentuação, números, espaços, ponto, apostrofo e hífen nas demais. Controles,
HTML, emojis e caracteres invisíveis não são aceitos. Limite bruto: 120 unidades
UTF-16. Identificador, sequencial e nome completo enviados pelo cliente são
rejeitados pelo ValidationPipe com whitelist e forbidNonWhitelisted.

## Legados e persistência

Registros anteriores continuam com três campos novos nulos e `legado: true`.
Não recebem identidade ou números retroativos. Podem ser consultados, editados,
duplicados e excluídos pelas mesmas regras anteriores. A próxima criação ou cópia
define a identidade e começa em 01; os legados permanecem distinguíveis mesmo
quando coexistem com times novos.

`DEFINIDA` com `total: 0` identifica quem excluiu todos os rascunhos novos;
o nome e o último número permanecem. `LEGADO` identifica rascunhos antigos sem
identidade; `NOVO` indica ausência de identidade e de rascunhos existentes.
Não é possível reconstruir exclusões de legados anteriores a esta fase, pois o
modelo anterior não mantinha histórico de exclusões.

## Validação e limites

Testes unitários verificam nomes, sequência, exclusão total, idempotência,
rollback com fake transacional, legados, isolamento e rejeição de campos forjados.
Testes MySQL adicionais verificam rollback real no primeiro salvamento,
dois primeiros salvamentos concorrentes, criação/duplicação simultâneas,
unicidades e FK composta. Sem banco dedicado, esses testes ficam explicitamente
ignorados: os testes com fake não comprovam isolamento ou execução do SQL.

Não houve commit, push, merge ou deploy. A validação real da migration e das
disputas de concorrência permanece pendente do banco local dedicado.

Validação histórica da fase 5B: 100 suítes aprovadas, 2.311 testes aprovados; 13 suítes e 78
testes ignorados pelas condições de integração existentes (incluindo MySQL).
`prisma validate`, geração do cliente, lint, typecheck, build e
`git diff --check` concluídos sem erros. O PowerShell marcou o redirecionamento
do stderr do Jest como NativeCommandError; o resumo do Jest registra zero falhas.

Arquivos alterados: `prisma/schema.prisma`, `lineup.service.ts`,
`lineup.controller.ts`, `lineup.dto.ts`, os testes existentes de controller,
serviço e integração de escalações. Arquivos novos: migration 0026,
`team-identity.ts`, `test/point-fantasy-team-identity.spec.ts` e este documento.


## Refinamento 5B.1

Novas identidades recebem exatamente 7 caracteres do alfabeto
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 símbolos; sem I/O/0/1), gerados por
`crypto.randomInt`, sem viés de módulo e sem derivar IDs internos. Espaço de
32^7 = 34.359.738.368 combinações. O código é um identificador de exibição,
nunca uma credencial: JWT e propriedade continuam obrigatórios.

O índice único global do código arbitra colisões. Somente P2002 identificado
como conflito desse índice, durante a inserção da identidade, dispara uma nova
transação Serializable, com código novo e os mesmos parâmetros originais.
O máximo é cinco tentativas totais; esgotamento retorna HTTP 409. Conflitos de
proprietário/competição, nome público, sequencial, deadlock ou índices desconhecidos
não são tratados como colisão de código e retornam 409 sem retry automático.
Não há atualização de códigos já atribuídos, mesmo que tenham 32 caracteres.

A migration 0026 existente foi ajustada de CHAR(32) para VARCHAR(32), preservando
capacidade para códigos anteriores sem truncamento e aceitando novos códigos
curtos. Não houve nova migration nem alteração de 0024/0025. Revisão estática:
DDL aditivo, tabelas e índices únicos coerentes com Prisma 5/MySQL, FK composta
com os mesmos tipos unsigned e alvo único, campos novos nulos para legados.
O código novo continua sendo gerado exclusivamente pelo servidor; os nomes
públicos e os contratos das rotas anteriores permanecem iguais, com o prefixo curto.

### Banco local: bloqueio e preparação segura

Foi encontrado o serviço MySQL80 ativo e o cliente MySQL Server 8.0 instalado.
Não há POINT_FANTASY_TEST_DATABASE_URL configurada. A consulta somente leitura
via TCP em 127.0.0.1:3306, sem senha, foi negada (1045). Não foi possível
identificar e verificar um banco vazio dedicado com credenciais disponíveis.
Não se consultou a conexão do .env nem se aplicou migration em banco algum.
Testes MySQL permanecem ignorados; sua cobertura não conta como aprovada.

Para preparar o ambiente, um administrador local deve abrir o cliente com senha
solicitada interativamente (não usar senha na linha de comando):

```powershell
& 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe' --no-defaults --protocol=TCP --host=127.0.0.1 --port=3306 --user=root --password
```

Criar um banco novo, exclusivo e descartável (se já existir, escolher outro
sufixo permitido; não reutilizar um banco sem confirmar que está vazio):

```sql
CREATE DATABASE point_fantasy_lineups_2a_test_phase5b1 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'point_fantasy_test'@'localhost' IDENTIFIED BY '<senha exclusiva escolhida localmente>';
GRANT ALL PRIVILEGES ON point_fantasy_lineups_2a_test_phase5b1.* TO 'point_fantasy_test'@'localhost';
SELECT COUNT(*) AS tabelas FROM information_schema.tables
WHERE table_schema = 'point_fantasy_lineups_2a_test_phase5b1';
```

Prosseguir somente com zero tabelas e banco recém-criado sem dados importantes.
O host da URL deve ser exatamente localhost ou 127.0.0.1 e o nome deve seguir
`point_fantasy_lineups_2a_test_[a-z0-9_]+`. Na mesma sessão PowerShell, montar a
conexão sem exibi-la, usando a senha solicitada em modo seguro:

```powershell
$testSecret = Read-Host 'Senha do usuario local de testes' -AsSecureString
$testCredential = New-Object System.Net.NetworkCredential('point_fantasy_test', $testSecret)
$testEncodedSecret = [Uri]::EscapeDataString($testCredential.Password)
$env:POINT_FANTASY_TEST_DATABASE_URL = 'mysql://point_fantasy_test:' + $testEncodedSecret + '@127.0.0.1:3306/point_fantasy_lineups_2a_test_phase5b1'
$previousDatabaseUrl = $env:DATABASE_URL
try {
  $env:DATABASE_URL = $env:POINT_FANTASY_TEST_DATABASE_URL
  npx.cmd prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Migration local falhou; nao executar os testes' }
  npm.cmd test -- --runInBand point-fantasy-lineup.integration
} finally {
  $env:DATABASE_URL = $previousDatabaseUrl
  Remove-Item Env:POINT_FANTASY_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  $testSecret = $null
  $testCredential = $null
  $testEncodedSecret = $null
}
```

O deploy aplica a cadeia de migrations existente ao banco vazio; não usa reset,
db push nem seeds. Os testes limpam somente seus próprios fixtures. Não apontar
essas variáveis para Render ou banco remoto. A execução real permanece pendente.

### Resultado de validação 5B.1

Suíte completa: 100 suítes aprovadas, 13 ignoradas; 2.318 testes aprovados,
82 ignorados e zero falhas (Jest exit code 0). Os 25 casos da suíte MySQL de
escalações estão entre os ignorados, incluindo colisões reais e concorrência.
Os testes unitários de colisões são simulações e não substituem esses casos.
`prisma validate`, geração do cliente, lint, typecheck, build e
`git diff --check` passaram. O build foi executado após encerrar o Jest, evitando
o bloqueio temporário da DLL do Prisma pelo Windows durante execução simultânea.
O SQL da
migration 0026 é idêntico ao diff gerado pelo Prisma entre o schema do HEAD
e o schema atual, sem acessar banco. Isso não comprova aplicação no MySQL.

Alterações específicas de 5B.1: `prisma/schema.prisma`, SQL da migration 0026,
`lineup.service.ts`, `team-identity.ts`, testes de identidade e integração de
escalações, além deste documento. As demais alterações da fase 5B foram preservadas.
Nenhum endpoint foi criado ou removido. O frontend continua usando
`identidade.identificadorPublico`, `nomePublico`, `sequencial` e
`estadoIdentidade` conforme o contrato acima; novos códigos têm 7 caracteres.
Riscos pendentes: executar a migration e comprovar os testes de concorrência,
colisões e rollback com o conector real no banco local dedicado.

## Validação real 5B.3 — 16/10/2026

Banco autorizado: `point_fantasy_lineups_2a_test_phase5b2_1792155483511`,
exclusivamente em `127.0.0.1:3306`, MySQL 8.0.25. Antes da aplicação foram
reconfirmados: branch correta, migrations 0001–0025 concluídas, todos os
checksums compatíveis, zero registros de aplicação e ausência da 0026.

`prisma migrate deploy` aplicou somente `0026_point_fantasy_team_identity`.
O histórico passou de 25 para 26 migrations concluídas, sem alterar checksums
anteriores. Foram verificados no information_schema os seis índices únicos
da identidade/escalação/operação e a FK composta com proprietário e competição.
Nenhum banco foi criado nesta etapa; os outros dois bancos não foram acessados.
Não houve alteração permanente de `.env`, conexão remota, migrate resolve,
reset, db push ou mudanças em migrations anteriores.

Integração dedicada: duas suítes MySQL, 28 testes aprovados, zero ignorados e
zero falhos (27 testes de escalações e um de catálogo/restrições). As suítes
usam a conexão explícita de testes, não criam bancos e limpam seus fixtures.
As demais integrações de carteira, PIX, ranking e serviços externos permaneceram
desativadas; os testes unitários correspondentes usam mocks.

Evidências no MySQL real:

- Primeiro salvamento preserva nome-base, código de sete caracteres e sequência 01.
- Dois primeiros salvamentos mantêm uma única identidade, com e sem chave de idempotência.
- Criação/criação, duplicação/duplicação e criação/duplicação simultâneas não repetem sequenciais;
  conflitos retornam 409 e retries com a mesma chave não criam novos resultados.
- Colisão forçada do código atinge o índice único real; nova tentativa funciona,
  sem alterar a identidade anterior. Esgotamento retorna 409 e não deixa identidade parcial.
- Reutilização da chave com parâmetros diferentes e renomeação são rejeitadas.
- Falha após escritas e falha no primeiro salvamento revertem a transação.
- Exclusão total preserva identidade; nova criação continua a sequência.
- Unicidades de identidade, nome público e sequencial, além da FK composta,
  rejeitam inserções inválidas diretamente no banco.
- Rascunho legado com campos de identidade nulos continua legível e editável;
  sua cópia define identidade nova, preservando o original sem nome público.

Foram adicionados dois testes de integração explícitos para o formato curto no
primeiro salvamento e o fluxo de legados. Não houve correção no código de produção
nem em SQL de migrations nesta etapa. Como o banco estava vazio antes da migration,
a compatibilidade de legados foi testada com fixture legado criado após a 0026;
não se afirma validação de migração sobre uma base previamente populada.

Na primeira execução geral, os 28 testes MySQL passaram, mas seis testes
unitários do cliente API Football falharam por configuração de ambiente herdada
pelo executor temporário. O carregamento do Prisma no processo pai havia
importado variáveis locais antes de iniciar o Jest. O executor foi ajustado para
passar o ambiente original do processo e apenas a conexão autorizada de testes,
sem alterar `.env` ou código de produção. A suíte foi executada novamente.

Resultado geral final: 102 suítes aprovadas, 11 ignoradas; **2.346 testes
aprovados, 56 ignorados e zero falhas**. Os **28 testes MySQL executaram**,
sem nenhum ignorado: 27 de escalações e um de catálogo/restrições. Os 56
ignorados pertencem às outras integrações não habilitadas nesta validação.
Após a suíte geral, nova inspeção confirmou as 26 migrations concluídas,
os seis índices únicos, a FK composta e **zero registros de aplicação restantes**.
Prisma validate, lint, typecheck, geração do Prisma Client, build e
`git diff --check` também passaram.

Prontidão: validação local do backend concluída para iniciar a integração com
o frontend, usando os contratos documentados acima. Permanecem para essa etapa
a validação das telas e dos fluxos de retry/409. Não houve publicação, commit,
push, merge ou deploy de aplicação; apenas o migrate deploy autorizado local.
