# POINT FFC Connect: webhook

The persistent bottom reply keyboard has two rows: **🏆 Competições** / **⚽ Participar grátis**, then **📋 Minhas inscrições** / **🔗 Minha conta**. The previous labels **🏆 Ver competições** and **🔗 Conectar minha conta** remain accepted, as do `/start` and `/vincular`. Competition selection and the free enrollment journey use inline keyboards attached to the current message. The journey supports paging, multi-selection, back, cancel, and return to the main menu. Public FREE and PAGO competition disclosure remains unchanged.

At startup, the API checks Telegram's webhook configuration and calls `setWebhook` only when the URL or required events are missing. It uses the existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, preserves other configured update types, and does not discard pending updates. The project has no existing webhook URL setting, so the URL is the code default:

Do not put the bot token or webhook secret in source control, logs, shell history, or shared documentation. The configured webhook endpoint remains:

```text
https://api-pointffc.onrender.com/integracoes/telegram/webhook
```

The webhook returns `503` when a required Telegram send fails, so Telegram can retry the update. A query failure is handled separately: the bot sends a generic response, and that update is complete only if the response send succeeds. A send failure after part of a competition list does not trigger a generic query-error message.

Only fully processed `update_id` values are deduplicated. The process keeps at most 1,000 completed IDs in memory. This is best effort: entries disappear on restart, are not shared across multiple instances, and older IDs can be evicted. Telegram may retry a failed webhook only a limited number of times. If delivery fails after some list messages were accepted, a retry can repeat those earlier messages because Telegram `sendMessage` has no idempotency key in this integration. No durable delivery queue or cross-instance deduplication is implemented.

## Telegram account linking

In a private chat, select **🔗 Minha conta** when disconnected or send `/vincular` to receive a 48-character random hexadecimal code. The previous **🔗 Conectar minha conta** label still starts the link flow. The bot sends an instruction message, the code by itself in a `code` entity for easier copying, then a final message with an inline URL button to `https://pointffc.com.br/conectar-telegram/`. The main reply keyboard is marked persistent and remains available alongside the inline button. The code expires in 10 minutes and can be used once. The Telegram user ID comes from the authenticated Telegram webhook update; it is not accepted from the browser. The raw code is sent only to that private chat and is never stored or logged. The database stores its SHA-256 hash.

The free participation selection is kept in process memory, scoped by Telegram user ID, expires 10 minutes after the last interaction, and is capped at 1,000 sessions. A random session token and one-use keyboard nonce bind each callback to the current session; callback data stays below Telegram's 64-byte limit. Telegram user ID, private chat ID, and inline message ID must all match. A process restart or eviction clears the selection; the user must start again. Opening a competition loads the active link, FREE competition, owned teams, registrations, and limits into the session. Selection and pagination callbacks use that snapshot without database queries. On **Continue**, the API revalidates the active link, competition, owned teams, registrations, per-user limit, and active participant capacity. If eligibility changed, it clears the selection and asks the user to choose again with the refreshed list. Selections are sorted by Cartola team ID for deterministic summaries. The summary requires an explicit **✅ Confirmar inscrição** action; **↩️ Voltar** returns to team selection. Confirmation uses the existing transactional `LotesInscricaoService.criarFree` batch path, which rechecks active account, FREE status, ownership, duplicate registrations and capacities under database locks. It persists all registrations in the same transaction. A random per-summary idempotency key is hashed and stored by the existing batch model; an uncertain retry keeps the same key and can recover the persisted receipt after a process restart. After confirmation, selection actions are invalidated and the receipt offers inline **📋 Minhas inscrições** and **🏠 Menu principal** actions. Repeated confirmation callbacks recover the same persisted result and cannot cancel an enrollment. FREE batches require a zero price and never open or debit a wallet. The existing batch service remains responsible for site and Telegram enrollment rules.

**📋 Minhas inscrições** requires an active Telegram link and queries rows scoped to the resolved `usuarioId` through `InscricoesCompeticaoService.minhasDoUsuario`. Current and future competitions are presented first, with inline pagination; this is read-only and does not change enrollment data. **🔗 Minha conta** reports active connection status without exposing account identifiers. If not linked, it starts the existing code flow; if linked, it offers a POINT FFC site link.

The final navigation-button message is best effort. If that send fails after the code was delivered, the webhook acknowledges the update and records it as completed, so Telegram redelivery does not create a replacement code or invalidate the delivered code. A safe warning is logged without code contents.

All API routes below require `Authorization: Bearer <POINT_FFC_JWT>`. The server derives `usuarioId` from the JWT's authenticated `Usuario`; callers cannot choose an account ID.

| Method and path | Payload | Result |
| --- | --- | --- |
| `POST /users/me/telegram-link/confirm` | `{"code":"<código recebido no Telegram>"}` | `{"linked":true,"linkedAt":"<ISO-8601>"}` |
| `GET /users/me/telegram-link` | none | `{"linked":false}` or the linked state and creation date |
| `DELETE /users/me/telegram-link` | none | `{"linked":false}` |

Unknown, expired, and used codes return the same invalid/expired response. If either identity already has a link, the API returns a generic conflict without identifying the other account. Blocked users are rejected by the existing `JwtAuthGuard`. Disconnect deletes the active relation, so it does not retain a revocation timestamp and both sides can be linked again.

Code issuance is limited to 3 attempts per Telegram user per hour; confirmation is limited to 10 attempts per authenticated user per 10 minutes. These counters live in process memory: restarts reset them and multiple API instances do not share them. The code has 192 bits of randomness, and database unique constraints plus an atomic conditional claim protect one-time use and both sides of the link across instances. Expired code rows are purged when a new request is created.

Migration `0021_telegram_account_link` creates `TELEGRAM_ACCOUNT_LINK` and `TELEGRAM_LINK_REQUEST`; it does not alter existing user rows. Roll out by backing up the database, applying and verifying the migration first, then deploying the API version that uses these tables. `src/main.ts` also runs `prisma migrate deploy` automatically when `NODE_ENV=production`, so use the established migration release procedure and do not start the new API against a database missing migration 0021. No frontend changes or migration execution against production are part of this change.
