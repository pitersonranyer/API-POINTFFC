# Configuração da hospedagem da API PointFFC

## Campos do painel de hospedagem

Preencha os campos da aplicação Node.js da seguinte maneira:

| Campo | Valor |
|---|---|
| Versão Node.js | `20.x` (recomendado) ou `18.x` |
| Modo de aplicação | `Production` |
| Variável `NODE_ENV` | `production` |
| Raiz do aplicativo | A pasta onde o projeto foi enviado, por exemplo `api-pointffc` |
| URL do aplicativo | O domínio público da API, por exemplo `https://api.seudominio.com.br` |
| Arquivo de inicialização | `dist/main.js` |

Se o painel possuir um campo para o comando de inicialização, use:

```bash
npm run start:prod
```

## Preparação da aplicação

Depois de enviar os arquivos, execute na raiz do aplicativo:

```bash
npm install
npx prisma generate
npm run build
```

O comando de build cria o arquivo `dist/main.js`, utilizado para iniciar a API em produção.

## Variáveis de ambiente

Cadastre as variáveis abaixo no painel da hospedagem. Os valores já conhecidos do projeto estão preenchidos; substitua somente os campos entre `<` e `>`.

```env
NODE_ENV=production
FRONTEND_URL=https://<DOMINIO_DO_FRONTEND>
DATABASE_URL=mysql://<USUARIO>:<SENHA>@<HOST>:3306/<NOME_DO_BANCO>
ROOT_EMAIL=pitersonranyer@gmail.com
JWT_SECRET=<COPIAR_JWT_SECRET_DO_ENV_LOCAL>
JWT_EXPIRES_IN=1h

FIREBASE_PROJECT_ID=app-pointdojogador
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-oz5lw@app-pointdojogador.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=<COPIAR_FIREBASE_PRIVATE_KEY_DO_ENV_LOCAL>

CARTOLA_API_URL=https://api.cartolafc.globo.com
CARTOLA_API_TIMEOUT_MS=5000

REDIS_URL=
REDIS_SCORED_STALE_TTL_SECONDS=86400
REDIS_LOCK_TTL_MS=10000
REDIS_LOCK_WAIT_MS=5000
```

### Valores que dependem da hospedagem

Solicite ou copie do painel dos serviços contratados:

| Variável | Origem do valor |
|---|---|
| `FRONTEND_URL` | Domínio público do frontend, sem barra no final |
| `DATABASE_URL` | Dados de conexão do banco MySQL de produção |
| `REDIS_URL` | Opcional. URL de conexão fornecida pelo serviço Redis, caso ele seja utilizado |

### Valores secretos existentes no `.env` local

Copie diretamente do arquivo `.env` local para o painel da hospedagem:

- `JWT_SECRET`
- `FIREBASE_PRIVATE_KEY`

Esses valores não foram escritos neste documento porque são credenciais privadas e o arquivo pode ser versionado no Git.

### Porta da aplicação

O projeto utiliza `PORT=3001` localmente. Se a hospedagem criar a variável `PORT` automaticamente, não cadastre outra. Caso o provedor exija uma porta fixa, adicione:

```env
PORT=3001
```

## Observações importantes

- `REDIS_URL` é opcional. Sem ela, a aplicação usa cache em memória; nesse modo, o cache não é compartilhado entre instâncias e é perdido a cada reinicialização.
- Se a hospedagem definir automaticamente a variável `PORT`, não cadastre uma porta manualmente. A API já utiliza a porta fornecida pelo servidor.
- `FRONTEND_URL` deve receber o endereço público do frontend, e não o endereço da API. Esse valor é usado na configuração de CORS.
- O arquivo `dist/main.js` somente existirá após a execução de `npm run build`.
- Não envie o arquivo `.env` real para o Git nem exponha suas credenciais em uma pasta pública.
- O valor de `JWT_SECRET` deve possuir no mínimo 32 caracteres e ser difícil de adivinhar.
- Preserve os `\n` no valor de `FIREBASE_PRIVATE_KEY`. Dependendo do painel, talvez seja necessário colar a chave com quebras de linha reais.

## Banco de dados

Com a `DATABASE_URL` configurada, aplique as migrações no banco de produção:

```bash
npx prisma migrate deploy
```

Use `prisma migrate deploy` em produção. O comando `prisma migrate dev` é destinado ao ambiente de desenvolvimento.

## Verificação

Depois que a aplicação estiver no ar, acesse a documentação Swagger:

```text
https://api.seudominio.com.br/docs
```

Se a página abrir, a API foi iniciada e está respondendo pelo domínio configurado.
