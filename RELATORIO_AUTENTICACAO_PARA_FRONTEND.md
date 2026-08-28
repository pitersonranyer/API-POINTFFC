# Handoff do Backend para o Frontend — Autenticação Firebase

## Arquitetura vigente

O Firebase Authentication é responsável por cadastro e login e-mail/senha, Google, senha, confirmação de e-mail, recuperação de senha e sessão de identidade. O backend não recebe nem armazena novas senhas. Colunas legadas permanecem temporariamente no banco apenas para evitar uma exclusão destrutiva de dados sem autorização.

```text
Firebase autentica e confirma identidade
→ frontend obtém Firebase ID Token atualizado
→ POST /auth/firebase/session
→ backend valida token e email_verified
→ sincroniza USUARIO no MySQL
→ emite JWT Fantasy Point
→ JWT protege as rotas internas
```

Backend local: `http://localhost:3001`; frontend local: `http://localhost:3000`; Swagger: `http://localhost:3001/docs`. Usar no frontend `NEXT_PUBLIC_API_URL=http://localhost:3001`.

## Endpoint de sessão

`POST /auth/firebase/session`

```json
{ "idToken": "firebase-id-token-atualizado" }
```

Resposta `200`:

```json
{
  "accessToken": "jwt-fantasy-point",
  "tokenType": "Bearer",
  "expiresIn": "1h",
  "user": {
    "idUsuario": "uuid",
    "nome": "Piterson",
    "email": "pitersonranyer@gmail.com",
    "fotoUrl": null,
    "tipoUsuario": "PLATFORM_ADMIN",
    "status": "ATIVO"
  }
}
```

- `401`: Firebase ID Token ausente, inválido, revogado ou expirado.
- `403`: e-mail não confirmado ou usuário bloqueado.
- Usuário interno só é criado/sincronizado após `email_verified=true`.
- O backend vincula por Firebase UID; uma conta legada com o mesmo e-mail somente é vinculada após o token verificado.
- `ROOT_EMAIL` confirmado recebe `PLATFORM_ADMIN`; o frontend nunca define função ou status.

## Rota interna

`GET /users/me`, usando exclusivamente o JWT Fantasy Point:

```http
Authorization: Bearer <accessToken>
```

Retorna o usuário público. JWT ausente/inválido/expirado retorna `401`; usuário bloqueado retorna `403`.

`GET /health` é público e retorna `{ "status": "ok" }`.

## Cadastro manual no frontend

1. Executar `createUserWithEmailAndPassword(auth, email, senha)`.
2. Executar `sendEmailVerification(user)`.
3. Exibir a tela **Confirme seu e-mail**; não chamar o backend nem abrir Dashboard.
4. Oferecer **Já confirmei meu e-mail**, **Reenviar e-mail** e **Sair**.
5. Em **Já confirmei**, executar `reload(user)` e ler novamente `user.emailVerified`.
6. Se ainda falso, informar que o e-mail não foi confirmado.
7. Se verdadeiro, executar `user.getIdToken(true)` para forçar claims atualizadas.
8. Enviar esse token a `/auth/firebase/session` e guardar a sessão retornada.

Impedir reenvios simultâneos, aplicar cooldown visual e traduzir erros Firebase sem mostrar mensagens técnicas cruas.

## Login e-mail/senha

1. Executar `signInWithEmailAndPassword`.
2. Não considerar o login suficiente para liberar Dashboard.
3. Se `emailVerified=false`, abrir a tela de confirmação.
4. Se verdadeiro, forçar `getIdToken(true)` e trocar pelo JWT no backend.

## Login Google

Usar `GoogleAuthProvider` + `signInWithPopup` (ou redirect). Após o Firebase concluir o login, obter o Firebase ID Token — não o Google OAuth token — e chamar `/auth/firebase/session`. Provedores Google normalmente fornecem e-mail verificado, mas o backend confere a claim.

## Recuperação de senha

Executar `sendPasswordResetEmail(auth, email)` no frontend. Não chamar o backend. Exibir resposta genérica para evitar enumeração de contas. Os templates são configurados no Firebase Console.

## Sessão e logout

O frontend terá dois estados relacionados: usuário Firebase e sessão Fantasy Point. Após recarregar a página, observar Firebase com `onAuthStateChanged`; se o e-mail estiver confirmado, obter ID Token atualizado e restaurar a sessão pelo backend.

Logout:

1. `signOut(auth)`;
2. apagar JWT e usuário do estado/local storage escolhido;
3. redirecionar para Login.

Ao receber `401` de uma rota interna, tentar recriar a sessão com um Firebase ID Token válido; se isso falhar, encerrar a sessão.

## Telas e estados necessários

- Login e-mail/senha e Google;
- Cadastro e-mail/senha;
- Confirme seu e-mail;
- Esqueci minha senha;
- carregando, erro de rede e rate limit;
- e-mail enviado, pendente, confirmado e reenviado;
- sessão autenticada e logout;
- proteção de páginas privadas.

Não implementar TOTP/SMS MFA, Apple, Facebook, 2FA, perfil ou módulos de negócio nesta etapa. A “segunda etapa” definida neste projeto é confirmação do e-mail, não autenticação multifator.

## Configuração Firebase necessária

- habilitar Email/Senha;
- habilitar Google;
- cadastrar `localhost` em domínios autorizados;
- revisar templates de verificação de e-mail e redefinição de senha;
- usar a configuração Firebase Client já existente no frontend;
- nunca colocar credenciais Firebase Admin ou JWT_SECRET no frontend.

## Estado técnico do backend

- Prisma/MySQL e dados preservados;
- autenticação local desativada;
- Firebase Admin valida tokens com checagem de revogação;
- e-mail não verificado é rejeitado antes de criar usuário;
- ROOT promovido somente por identidade Firebase verificada;
- TypeScript, lint e build aprovados;
- 6 testes automatizados aprovados.
