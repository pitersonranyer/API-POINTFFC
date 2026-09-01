# Análise arquitetural — pontuação parcial do Cartola FC

## Contexto e objetivo futuro

Esta análise registra o estado atual do backend `api-pointffc` antes da implementação de qualquer funcionalidade de pontuação parcial.

O objetivo futuro é preparar o sistema para:

- suportar ligas com mais de 5.000 times;
- calcular a pontuação parcial de cada time por rodada;
- utilizar escalações persistidas;
- utilizar `/atletas/pontuados` como fonte global de pontuação;
- processar substituições após o encerramento dos jogos;
- aplicar multiplicador de 1,5 ao capitão;
- evitar chamadas à API do Cartola durante a abertura de listas e rankings;
- permitir uma integração futura com Redis.

Nenhuma implementação faz parte desta etapa.

## 1. Estrutura atual de pastas

```text
Api-Pointffc/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│       ├── 0001_create_usuario/
│       ├── 0002_complete_authentication/
│       ├── 0003_create_time_usuario/
│       └── migration_lock.toml
├── scripts/
├── src/
│   ├── auth/
│   │   ├── dto/
│   │   ├── auth.controller.ts
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts
│   │   ├── firebase.service.ts
│   │   ├── jwt-auth.guard.ts
│   │   └── authenticated-user.decorator.ts
│   ├── cartola/
│   │   ├── dto/
│   │   ├── cartola-cache.service.ts
│   │   ├── cartola-http.client.ts
│   │   ├── cartola.controller.ts
│   │   ├── cartola.module.ts
│   │   ├── cartola.service.ts
│   │   └── cartola.types.ts
│   ├── config/
│   │   └── environment.validation.ts
│   ├── health/
│   ├── meus-times/
│   │   ├── dto/
│   │   ├── meus-times.controller.ts
│   │   ├── meus-times.module.ts
│   │   └── meus-times.service.ts
│   ├── prisma/
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   ├── users/
│   │   ├── dto/
│   │   ├── users.controller.ts
│   │   ├── users.module.ts
│   │   └── users.service.ts
│   ├── app.module.ts
│   └── main.ts
├── test/
│   ├── cartola-cache.service.spec.ts
│   ├── cartola-http.client.spec.ts
│   ├── cartola-teams.service.spec.ts
│   ├── cartola.controller.spec.ts
│   ├── cartola.service.spec.ts
│   ├── firebase-session.spec.ts
│   ├── jwt-auth.guard.spec.ts
│   └── meus-times.service.spec.ts
├── .env.example
├── package.json
├── tsconfig.json
└── nest-cli.json
```

O diretório `scripts/` está presente, mas não contém arquivos identificados no inventário.

## 2. Padrão arquitetural utilizado

### Controllers

Os controllers NestJS recebem as requisições HTTP, utilizam DTOs para validação, documentam as operações com Swagger e delegam a execução aos services.

Controllers existentes:

- `src/cartola/cartola.controller.ts`;
- `src/meus-times/meus-times.controller.ts`;
- `src/users/users.controller.ts`;
- `src/auth/auth.controller.ts`;
- `src/health/health.controller.ts`.

A aplicação utiliza um `ValidationPipe` global com:

- `whitelist: true`;
- `forbidNonWhitelisted: true`;
- `transform: true`.

### Services

Os services concentram as regras e integrações:

- `CartolaService`: orquestra chamadas externas e cache;
- `MeusTimesService`: gerencia vínculos de usuários com times e acessa o Prisma diretamente;
- `UsersService`: sincroniza usuários com identidades Firebase;
- `AuthService`: autentica usuários, emite JWT e valida sessões;
- `FirebaseService`: encapsula o Firebase Admin.

### Repositories

Não existe uma camada explícita de repositories. Os services utilizam o `PrismaService` diretamente.

Esse padrão atende ao tamanho atual do projeto. Consultas complexas de pontuação, agregações em lote e operações idempotentes poderão justificar repositories internos, desde que a introdução seja consistente e gradual.

### Models e entities

Não existem classes próprias de entidade. Os modelos são definidos no Prisma e os tipos são gerados por `@prisma/client`.

Os DTOs representam contratos HTTP. Os payloads externos do Cartola são representados por interfaces TypeScript, algumas ainda bastante genéricas.

### Routes

Não existem arquivos separados de rotas. Elas são declaradas por decorators nos controllers.

Rotas principais:

- `POST /auth/firebase/session`;
- `GET /users/me`;
- `GET /health`;
- `GET /meus-times`;
- `POST /meus-times`;
- `POST /meus-times/importar`;
- `DELETE /meus-times/:timeId`;
- `GET /cartola/mercado/status`;
- `GET /cartola/atletas/mercado`;
- `GET /cartola/atletas/pontuados`;
- `GET /cartola/atletas/pontuados/:rodada`;
- `GET /cartola/clubes`;
- `GET /cartola/times?nome=...`;
- `GET /cartola/times/:timeId`;
- `POST /cartola/times/buscar-por-ids`;
- `GET /cartola/partidas`;
- `GET /cartola/partidas/:rodada`;
- `GET /cartola/dashboard`.

### Migrations

As migrations SQL estão versionadas em `prisma/migrations`:

1. `0001_create_usuario`: cria `USUARIO`;
2. `0002_complete_authentication`: complementa autenticação e cria contas/tokens;
3. `0003_create_time_usuario`: cria `TIME_USUARIO`.

O script `prisma:migrate` usa `prisma migrate dev`. O README recomenda `prisma migrate deploy` para aplicar migrations no ambiente de execução.

## 3. Configuração do MySQL

O datasource Prisma está configurado assim:

```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```

A conexão é fornecida integralmente por `DATABASE_URL`:

```env
DATABASE_URL="mysql://usuario:senha@localhost:3306/fantasy_point"
```

O `PrismaService`:

- é registrado globalmente pelo `PrismaModule`;
- estende `PrismaClient`;
- conecta no `onModuleInit`;
- desconecta no `onModuleDestroy`.

Não existem configurações explícitas no projeto para tamanho do pool, timeout de conexão, SSL, réplicas de leitura, slow queries ou métricas de banco.

## 4. Chamadas atuais para a API do Cartola

As chamadas externas são centralizadas em `src/cartola/cartola-http.client.ts`.

O cliente:

- utiliza o `fetch` nativo;
- monta a URL com `CARTOLA_API_URL`;
- envia `Accept: application/json`;
- envia `User-Agent: FantasyPointBackend/1.0`;
- utiliza `AbortController` para timeout;
- usa `CARTOLA_API_TIMEOUT_MS`, com padrão de 5 segundos;
- converte timeout em HTTP 503;
- converte respostas externas inválidas em HTTP 502;
- trata 404 de time quando solicitado pelo service;
- registra falhas com o logger do NestJS.

Não existem atualmente:

- retries;
- backoff exponencial;
- circuit breaker;
- rate limiter;
- autenticação específica do Cartola;
- métricas de latência ou erro;
- persistência automática dos payloads recebidos.

## 5. Serviços e endpoints Cartola reutilizáveis

### `getScoredAthletes(round?)`

Consulta:

- `/atletas/pontuados`;
- `/atletas/pontuados/:rodada`.

É o serviço diretamente reutilizável como fonte global de pontuações.

TTL atual:

- 15 segundos com bola rolando;
- 10 minutos com mercado aberto;
- 1 minuto nos demais estados.

Antes da consulta, o service também consulta o estado do mercado.

### `getMarketStatus()`

Consulta `/mercado/status` e permite identificar:

- rodada atual;
- mercado aberto ou fechado;
- `bola_rolando`;
- `game_over`, quando presente.

Pode orientar o ciclo de processamento, mas não deve ser o único mecanismo para decidir o encerramento das partidas ou a aplicação de substituições.

### `getMatches()` e `getMatchesByRound()`

Consultam `/partidas` e `/partidas/:rodada`.

O contrato atual possui campos para:

- IDs dos clubes;
- data e timestamp;
- placar;
- período e status do cronômetro;
- indicação de partida válida.

São os melhores serviços existentes para auxiliar na identificação do encerramento de partidas.

### `getTeamById()`

Consulta `/time/id/:timeId`. O payload pode conter escalação, capitão e reservas, mas esses dados ainda não são normalizados nem persistidos.

O endpoint pode ser usado em um processo controlado de captura de escalação. Não deve ser chamado durante a leitura de listas ou rankings.

### Outros serviços úteis

- `getMarketAthletes()`: catálogo e metadados de atletas;
- `getClubs()`: catálogo de clubes;
- `getTeamsByIds()`: importação pequena, limitada a 50 IDs e cinco chamadas simultâneas;
- `CartolaCacheService`: TTL, deduplicação de chamadas simultâneas e fallback stale.

## 6. Modelagem atual

### Usuários

O model `Usuario` contém:

- UUID interno;
- Firebase UID opcional;
- hash de senha opcional;
- nome, e-mail e foto;
- tipo `PLAYER`, `ORGANIZER` ou `PLATFORM_ADMIN`;
- status `ATIVO`, `INATIVO` ou `BLOQUEADO`;
- timestamps;
- contas de autenticação;
- tokens de recuperação;
- vínculos com times.

### Times

Não existe uma entidade global de time Cartola.

O model `TimeUsuario` representa a associação entre um usuário e um time e também mantém uma cópia dos seus metadados:

- `usuarioId`;
- `timeId` do Cartola;
- nome;
- nome do cartoleiro;
- slug;
- escudo;
- foto;
- indicador de assinante;
- timestamps.

A chave primária é composta por `(usuarioId, timeId)`. O mesmo time do Cartola pode aparecer repetido para usuários diferentes.

Não são armazenados temporada, escalação, reservas, capitão, rodada, pontuação, patrimônio histórico ou estado de substituição.

### Ligas

Não existe model, tabela, módulo ou endpoint de liga.

### Competições

Não existe model, tabela, módulo ou endpoint de competição.

### Inscrições

Não existe model ou tabela de inscrição. `TimeUsuario` representa propriedade ou vínculo pessoal, não inscrição em uma liga ou competição.

## 7. Cache e processamento assíncrono

| Recurso | Situação atual |
|---|---|
| Cache | Sim, em memória com `Map` |
| Redis | Não |
| Scheduler/cron | Não |
| Jobs/workers | Não |
| Filas | Não |
| Deduplicação in-flight | Sim, somente na mesma instância |
| Fallback stale | Sim, enquanto o processo permanecer ativo |

O cache atual possui dois mapas internos: um para entradas e outro para promises em execução.

Limitações:

- cada instância da API mantém seu próprio cache;
- reiniciar a aplicação elimina os dados;
- não existe invalidação distribuída;
- réplicas diferentes podem consultar o Cartola simultaneamente;
- entradas expiradas podem permanecer como fallback stale sem um limite adicional;
- não existe limite de quantidade de chaves ou memória.

## 8. Variáveis de ambiente

O projeto utiliza `@nestjs/config`, carregado globalmente no `AppModule`, e validação Joi em `src/config/environment.validation.ts`.

Variáveis atuais:

- `NODE_ENV`;
- `PORT`;
- `FRONTEND_URL`;
- `DATABASE_URL`;
- `ROOT_EMAIL`;
- `JWT_SECRET`;
- `JWT_EXPIRES_IN`;
- `FIREBASE_PROJECT_ID`;
- `FIREBASE_CLIENT_EMAIL`;
- `FIREBASE_PRIVATE_KEY`;
- `CARTOLA_API_URL`;
- `CARTOLA_API_TIMEOUT_MS`.

O `.env.example` documenta essas variáveis. A chave privada Firebase converte sequências `\n` em quebras de linha reais.

Para a evolução proposta, ainda serão necessárias configurações para Redis, scheduler, locks, concorrência, intervalos de atualização, tentativas e retenção.

## 9. Estrutura dos testes

Os testes utilizam Jest com `ts-jest`, ficam em `test/` e seguem o padrão `*.spec.ts`.

São predominantemente testes unitários com mocks manuais e cobrem:

- cache hit, miss, stale e deduplicação;
- cliente HTTP: sucesso, 502, 503 e 404;
- TTLs e regras de mercado no CartolaService;
- concorrência e resultados parciais na busca de times;
- controller e validação de DTOs;
- vínculos entre usuários e times;
- autenticação Firebase;
- JWT guard.

Não foram encontrados:

- testes e2e com a aplicação Nest iniciada;
- testes contra MySQL real ou containerizado;
- testes de migrations;
- testes de concorrência no banco;
- testes de carga;
- contract tests com payloads reais do Cartola;
- fixtures completas de escalação e `/atletas/pontuados`.

## 10. Arquivos provavelmente afetados no futuro

### Alterações prováveis

- `prisma/schema.prisma`;
- novas migrations em `prisma/migrations/`;
- `src/app.module.ts`;
- `src/config/environment.validation.ts`;
- `.env.example`;
- `src/cartola/cartola.types.ts`;
- `src/cartola/cartola.service.ts`;
- `src/cartola/cartola-cache.service.ts`;
- `src/cartola/cartola.module.ts`.

### Novos módulos prováveis

- `src/ligas/`;
- `src/competicoes/`;
- `src/inscricoes/`;
- `src/escalacoes/`;
- `src/pontuacoes/`;
- `src/jobs/` ou `src/processamento/`;
- `src/cache/` ou `src/redis/`.

Cada módulo pode manter o padrão atual de `module`, `controller`, `service` e `dto`.

### Testes necessários

- captura e imutabilidade da escalação;
- aplicação do multiplicador de capitão;
- substituições;
- idempotência do processamento;
- atualização global de atletas;
- ranking sem chamadas externas;
- concorrência de workers;
- retomada após falha;
- processamento de milhares de inscrições;
- consistência por temporada e rodada.

## Riscos técnicos e inconsistências

### 1. Ausência do agregado central

Liga, competição, inscrição, rodada e escalação ainda não estão modeladas. A pontuação não deve ser adicionada diretamente a `TimeUsuario` antes da definição desse domínio.

### 2. Time Cartola não é uma entidade global

Os metadados são repetidos por usuário. Para ligas grandes, é preferível possuir uma entidade global identificada por `timeId`, mantendo propriedade e inscrições em tabelas associativas.

### 3. Falta de temporada nas chaves

Uma rodada isolada não identifica historicamente uma pontuação. Chaves de escalação e pontuação devem incluir pelo menos temporada e rodada.

### 4. Escalação não persistida

Sem snapshot por rodada, a pontuação depende do estado atual da API externa e não pode ser reproduzida ou auditada com segurança.

### 5. Chamadas externas durante fluxos de leitura

Os endpoints Cartola são orientados a consultas sob demanda. Os rankings futuros devem ler somente dados locais previamente calculados.

### 6. Cache local incompatível com escala horizontal

A deduplicação funciona apenas dentro de um processo. Múltiplas instâncias poderão buscar ou processar a mesma rodada simultaneamente.

### 7. Ausência de execução única e idempotência explícita

Jobs concorrentes poderão recalcular a mesma rodada. Será necessário garantir idempotência por restrições únicas e upserts, além de locks distribuídos quando Redis for introduzido.

### 8. Importação sequencial e limitada

`adicionarTimesEmLote` executa um `create` por item dentro de um loop e aceita no máximo 50 entradas. Esse padrão não atende a operações com 5.000 times.

### 9. Payloads críticos pouco tipados

`CartolaPayload` aceita `Record<string, unknown> | unknown[]`. Os contratos de `/atletas/pontuados` e `/time/id/:id` devem ser tipados e validados defensivamente antes de alimentar o motor de cálculo.

### 10. Ausência de resiliência externa

Não existem retry, backoff ou circuit breaker. Falhas transitórias podem interromper ciclos completos de atualização.

### 11. Regra de substituição ainda não especificada

Antes da implementação é necessário definir:

- quando uma partida é considerada encerrada;
- quando um reserva pode entrar;
- compatibilidade de posição;
- prioridade dos reservas;
- comportamento quando o capitão é substituído;
- diferença entre atleta sem pontuação e atleta que não jogou;
- tratamento de correções posteriores publicadas pelo Cartola.

### 12. Precisão numérica

O multiplicador de 1,5 exige uma política explícita de precisão e arredondamento. Para persistência, um tipo decimal é mais seguro do que ponto flutuante binário.

### 13. Ausência de observabilidade

Não há métricas de ingestão, atraso, times calculados, falhas por rodada ou duração dos ciclos.

### 14. Cobertura somente unitária

O caminho crítico dependerá de transações, índices, upserts e concorrência. Ele deverá ser validado com MySQL e testes de integração.

### 15. Possível inconsistência de encoding

Algumas mensagens do projeto aparecem com caracteres corrompidos, por exemplo `invÃ¡lido`. Pode ser apenas interpretação do terminal, mas deve ser verificado antes da ampliação dos contratos e da documentação.

## Encaixe recomendado preservando os padrões existentes

A nova funcionalidade deve separar ingestão, cálculo e consulta:

```text
API do Cartola
    ↓ ingestão controlada
Pontuações globais de atletas por temporada e rodada
    ↓
Escalações persistidas por time e rodada
    ↓ cálculo idempotente
Pontuação parcial ou final por inscrição
    ↓
Endpoints de liga e ranking consultam somente o MySQL
```

### Modelos conceituais recomendados

- `TimeCartola`: cadastro global do time;
- `Liga`;
- `Competicao`;
- `Inscricao`: relação entre competição e time;
- `RodadaCompeticao`: estado do processamento;
- `Escalacao`: snapshot do time em uma rodada;
- `EscalacaoAtleta`: titulares, reservas, posição, prioridade e capitão;
- `PontuacaoAtletaRodada`: espelho global de `/atletas/pontuados`;
- `PontuacaoTimeRodada`: total calculado, estado parcial/final, versão e timestamps;
- `SubstituicaoTimeRodada`: trilha auditável opcional das substituições.

### Fluxo recomendado

1. Capturar as escalações em uma janela controlada e persistir snapshots imutáveis.
2. Consultar `/atletas/pontuados` uma única vez por ciclo.
3. Persistir pontuações por `temporada + rodada + atletaId` usando upsert.
4. Calcular os times em lotes a partir dos dados locais.
5. Aplicar capitão e substituições de forma determinística.
6. Persistir os totais parciais ou finais.
7. Servir rankings exclusivamente a partir do MySQL.
8. Introduzir Redis posteriormente atrás de abstrações de cache e lock, sem modificar os contratos dos controllers.

### Preservação dos padrões do projeto

- controllers devem permanecer finos;
- DTOs devem validar os contratos de entrada e saída;
- services devem orquestrar regras de negócio;
- Prisma deve continuar responsável pela persistência;
- chamadas ao Cartola devem permanecer centralizadas no módulo `cartola`;
- processamento deve ser idempotente desde o primeiro desenho;
- rankings devem ser projeções locais, sem dependência síncrona da API externa.

## Conclusão

A primeira decisão arquitetural deve ser a modelagem de temporada, liga, competição, inscrição e snapshot de escalação. Implementar o cálculo antes dessas estruturas criaria acoplamento com `TimeUsuario`, dificultaria auditoria histórica e provavelmente geraria retrabalho.

O projeto já possui bons pontos de partida — modularização NestJS, Prisma, validação global, cliente Cartola centralizado e uma interface conceitual de cache —, mas precisa adicionar persistência do domínio esportivo e processamento assíncrono antes de atender com segurança ligas com mais de 5.000 times.
