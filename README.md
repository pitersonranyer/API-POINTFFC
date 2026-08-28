# Api-Pointffc

Backend oficial do Fantasy Point do Jogador. Firebase gerencia identidades; a API sincroniza usuários verificados e emite o JWT próprio.

## Configuração

1. Copie `.env.example` para `.env` e preencha MySQL e Firebase Admin.
2. Execute `npm install`.
3. Execute `npx prisma migrate deploy`.
4. Inicie com `npm run start:dev`.

Swagger: `http://localhost:3001/docs`  
Health check: `http://localhost:3001/health`

Endpoints: `POST /auth/firebase/session`, `GET /users/me` e `GET /health`.

`POST /auth/firebase/session` recebe um Firebase ID Token com e-mail confirmado. `GET /users/me` exige `Authorization: Bearer <jwt-fantasy-point>`.
