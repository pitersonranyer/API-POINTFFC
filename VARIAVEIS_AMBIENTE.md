# Variáveis de ambiente — API PointFFC

Este documento consolida as variáveis lidas pelo código atual. Os valores abaixo são os valores locais encontrados no projeto ou os padrões definidos pela aplicação.

> **Segurança:** `JWT_SECRET` e `FIREBASE_PRIVATE_KEY` são credenciais. Seus valores completos estão no arquivo local `.env` e não são repetidos aqui para evitar que sejam enviados ao Git. O `.env` já está ignorado pelo `.gitignore`.

## Ambiente local

Use este conteúdo como referência para o arquivo `.env`:

```env
NODE_ENV=development
PORT=3001
FRONTEND_URL=http://localhost:3000
DATABASE_URL="mysql://root:admin@127.0.0.1:3306/fantasy_point_do_jogador"
ROOT_EMAIL=pitersonranyer@gmail.com

JWT_SECRET=<usar o valor atual do arquivo .env>
JWT_EXPIRES_IN=1h

FIREBASE_PROJECT_ID=app-pointdojogador
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-oz5lw@app-pointdojogador.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=<usar o valor atual do arquivo .env, preservando os \n>

CARTOLA_API_URL=https://api.cartolafc.globo.com
CARTOLA_API_TIMEOUT_MS=5000

REDIS_URL=
REDIS_SCORED_STALE_TTL_SECONDS=86400
REDIS_LOCK_TTL_MS=10000
REDIS_LOCK_WAIT_MS=5000
```

## Ambiente de produção

No painel da hospedagem, configure:

```env
NODE_ENV=production
PORT=<porta fornecida pela hospedagem ou 3001>
FRONTEND_URL=https://<dominio-do-frontend>
DATABASE_URL=mysql://<usuario>:<senha>@<host>:<porta>/<banco>
ROOT_EMAIL=pitersonranyer@gmail.com

JWT_SECRET=<copiar o valor atual do .env ou gerar um novo segredo com pelo menos 32 caracteres>
JWT_EXPIRES_IN=1h

FIREBASE_PROJECT_ID=app-pointdojogador
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-oz5lw@app-pointdojogador.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=<copiar o valor atual do .env>

CARTOLA_API_URL=https://api.cartolafc.globo.com
CARTOLA_API_TIMEOUT_MS=5000

REDIS_URL=redis://<usuario>:<senha>@<host>:<porta>
REDIS_SCORED_STALE_TTL_SECONDS=86400
REDIS_LOCK_TTL_MS=10000
REDIS_LOCK_WAIT_MS=5000
```

`REDIS_URL` é opcional em todos os ambientes. Quando ela estiver ausente ou vazia, a aplicação usa cache em memória.

## Referência completa

| Variável | Obrigatória | Valor local/padrão | Finalidade |
|---|---:|---|---|
| `NODE_ENV` | Não | `development` | Ambiente da aplicação: `development`, `test` ou `production`. |
| `PORT` | Não | `3001` | Porta HTTP. A hospedagem pode definir esse valor automaticamente. |
| `FRONTEND_URL` | Sim | `http://localhost:3000` | Origem permitida pelo CORS. |
| `DATABASE_URL` | Sim | `mysql://root:admin@127.0.0.1:3306/fantasy_point_do_jogador` | Conexão MySQL utilizada pelo Prisma. |
| `ROOT_EMAIL` | Sim | `pitersonranyer@gmail.com` | E-mail reconhecido como usuário root. |
| `JWT_SECRET` | Sim | Definido no `.env` | Assinatura dos tokens JWT; mínimo de 32 caracteres. |
| `JWT_EXPIRES_IN` | Não | `1h` | Duração do token JWT. |
| `FIREBASE_PROJECT_ID` | Sim | `app-pointdojogador` | ID do projeto Firebase. |
| `FIREBASE_CLIENT_EMAIL` | Sim | `firebase-adminsdk-oz5lw@app-pointdojogador.iam.gserviceaccount.com` | Conta de serviço do Firebase Admin. |
| `FIREBASE_PRIVATE_KEY` | Sim | Definido no `.env` | Chave privada da conta de serviço Firebase. |
| `CARTOLA_API_URL` | Não | `https://api.cartolafc.globo.com` | URL base da API do Cartola. |
| `CARTOLA_API_TIMEOUT_MS` | Não | `5000` | Timeout das requisições ao Cartola, entre 1000 e 30000 ms. |
| `REDIS_URL` | Não | Vazio | Conexão Redis. Aceita os protocolos `redis://` e `rediss://`; sem ela, usa cache em memória. |
| `REDIS_SCORED_STALE_TTL_SECONDS` | Não | `86400` | Tempo de retenção do cache de atletas pontuados. |
| `REDIS_LOCK_TTL_MS` | Não | `10000` | Duração do lock distribuído no Redis. |
| `REDIS_LOCK_WAIT_MS` | Não | `5000` | Tempo máximo de espera pelo lock do Redis. |

## Variáveis exclusivas dos testes

Estas variáveis são opcionais e só habilitam suítes que ficam desativadas por padrão:

```env
RUN_MYSQL_INTEGRATION_TESTS=false
RUN_REDIS_INTEGRATION_TESTS=false
RUN_RANKING_BENCHMARK=false
```

Defina como `true` apenas quando os serviços correspondentes estiverem disponíveis. Os testes Redis também exigem `REDIS_URL` preenchida.

## Entradas antigas encontradas no `.env`

As variáveis abaixo existem no `.env` local, mas não são lidas por nenhum arquivo da aplicação atual:

```env
GOOGLE_CLIENT_ID=
PASSWORD_RESET_EXPIRES_IN=30
```

Elas não precisam ser configuradas para a versão atual da API. Podem ser mantidas somente se houver compatibilidade planejada com uma funcionalidade futura ou antiga.

## Observações

- Preserve os caracteres `\n` da `FIREBASE_PRIVATE_KEY` quando usar uma única linha. O código os converte em quebras de linha reais.
- Não adicione o `.env` ao Git.
- Após configurar o banco de produção, execute `npx prisma migrate deploy`.
