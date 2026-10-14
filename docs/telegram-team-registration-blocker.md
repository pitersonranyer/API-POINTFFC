# Telegram team registration: authorization blocker

## Finding

Phase 3C.1 cannot safely associate a Cartola team with the POINT FFC account linked to Telegram using the current backend contract.

The authenticated `POST /meus-times` route derives `usuarioId` from the JWT, but its body supplies `timeId` and the team profile fields (`nome`, `nomeCartola`, `slug`, shield/profile URLs, and subscriber status). `MeusTimesService.adicionarTime` persists those supplied fields directly. It does not query Cartola or establish that the authenticated user controls the team.

The Cartola lookup `GET /cartola/times/:timeId` calls `CartolaService.getTeamDetail` and returns public team data. The Cartola HTTP client makes an unauthenticated GET request. The response can confirm that an ID exists and provide its public name and profile fields; it does not prove control of that team.

`TIME_USUARIO` has a composite primary key `(USUARIO_ID, TIME_ID)` and only an index on `TIME_ID`. It prevents the same user from adding the same team twice, but it does not prevent the same Cartola team from being associated with different POINT FFC users. The current persistence constraint therefore is not a team ownership check.

Relevant implementation:

- `src/meus-times/meus-times.controller.ts`: authenticated `POST /meus-times` passes the JWT-derived user ID and request body to the service.
- `src/meus-times/meus-times.service.ts`: `adicionarTime` creates `TimeUsuario` from the submitted DTO and handles only same-user duplicate key errors.
- `src/meus-times/dto/adicionar-time.dto.ts`: accepts the team ID and profile attributes from the caller.
- `src/cartola/cartola.controller.ts` and `src/cartola/cartola.service.ts`: expose public team lookup by ID.
- `src/cartola/cartola-http.client.ts`: performs the lookup without Cartola user credentials.
- `prisma/schema.prisma`, `TimeUsuario`: uses `(usuarioId, timeId)` as the primary key; no global uniqueness or ownership proof exists.

## Security consequence

Adding the Telegram journey on top of these contracts would let any Telegram-linked POINT FFC user submit another person's public team ID and associate it with their own profile. Looking up the ID first, displaying the real name, requiring an explicit button press, or rechecking the same public endpoint at confirmation does not change that authorization gap.

The Telegram account link proves which POINT FFC user is acting. It does not prove that user owns the Cartola team. The team ID is an identifier, not an ownership credential.

## Smallest compatible next step

Before enabling the Telegram association, establish an ownership proof that the backend can verify and that does not rely on a team ID or public profile fields alone. The verification method must be confirmed against capabilities actually supported by Cartola; this repository contains no Cartola OAuth/session flow or other ownership-verification contract.

Once such a method exists, centralize the authorization in the existing `MeusTimesService` so the site and Telegram use the same rule. The Telegram flow can then reuse that service for preview and explicit confirmation, with the authenticated POINT FFC user resolved from the active Telegram link. The final persistence operation must revalidate the proof and preserve the existing duplicate behavior. Do not accept Cartola passwords or session tokens in Telegram messages.

Potential investigation for a follow-up (not implemented here): verify whether Cartola provides a supported user authorization/API mechanism or a supported owner-controlled challenge. If neither exists, product/security must select an acceptable proof before team association can be offered from Telegram. Do not substitute matching the Cartola manager's display name or possession of a public team ID.

## Scope outcome

No Telegram team-registration code was added. In particular, this change does not add team IDs to selection sessions, persist any association, alter the site contract, or change enrollment behavior. Phase 3C.1 remains blocked until ownership authorization is available in a reusable backend service.
