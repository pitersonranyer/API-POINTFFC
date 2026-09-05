# Api-Pointffc

Backend oficial do Fantasy Point do Jogador. Firebase gerencia identidades; a API sincroniza usuários verificados e emite o JWT próprio.

## Configuração

1. Copie `.env.example` para `.env` e preencha MySQL e Firebase Admin.
2. Execute `npm install`.
3. Execute `npx prisma migrate deploy`.
4. Inicie com `npm run start:dev`.

Swagger: `http://localhost:3001/docs`  
Health check: `http://localhost:3001/health`

## Deploy

### Recuperação administrativa sem backup

`node scripts/recover-last-round.cjs` recupera os atletas e partidas da última rodada encerrada na janela atual do Cartola. O processamento normal conclui a consolidação.

Depois, `node scripts/import-ranking-teams.cjs ID1 ID2` cadastra os times e importa os totais finais oficiais disponíveis dessa rodada, sem sobrescrever registros existentes. Essa recuperação não reconstrói escalações congeladas nem substituições: os totais importados não devem ser recalculados como snapshots originais. Times sem pontuação permanecem fora do ranking. Para acompanhamento nas próximas rodadas, vincule os times a um usuário em Meus Times; o cadastro administrativo não cria esse vínculo.

Configure `NODE_ENV=production` e `DATABASE_URL` no ambiente da hospedagem, execute `npm install` e `npm run build`, e inicie com `npm run start:prod`.

Em produção, o backend executa `prisma migrate deploy` antes de criar a aplicação e iniciar o processamento de rodadas. Isso também acontece ao executar `node dist/main.js` diretamente. Se uma migration falhar, o processo encerra com código 1 sem abrir o servidor.

Inclua a pasta `prisma` completa (schema e migrations) no deploy, junto de `dist` e das dependências. O usuário do banco precisa de permissão para executar as alterações das migrations. Em desenvolvimento, as migrations continuam sendo aplicadas manualmente.

Antes do primeiro deploy com essa automação, confira `npx prisma migrate status` no banco de produção: a migration histórica `0008_recreate_tables_with_integer_ids` apaga e recria tabelas caso ainda esteja pendente.

Endpoints: `POST /auth/firebase/session`, `GET /users/me` e `GET /health`.

`POST /auth/firebase/session` recebe um Firebase ID Token com e-mail confirmado. `GET /users/me` exige `Authorization: Bearer <jwt-fantasy-point>`.
