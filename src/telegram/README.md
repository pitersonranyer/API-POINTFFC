# POINT FFC Connect: webhook

The menu uses a Telegram reply keyboard. Selecting **🏆 Ver competições**, **🔗 Conectar minha conta** or **⚽ Participar grátis** arrives as a regular private `message`. The free participation flow then uses inline keyboard callbacks to select multiple owned teams, paginate, select or clear all, and preview the selection. It verifies the active Telegram link and current competition/team eligibility before applying each callback. This remains a preview only: it does not create an inscription or call wallet services. Public FREE and PAGO competition disclosure remains unchanged.

At startup, the API checks Telegram's webhook configuration and calls `setWebhook` only when the URL or required events are missing. It uses the existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, preserves other configured update types, and does not discard pending updates. The project has no existing webhook URL setting, so the URL is the code default:

Do not put the bot token or webhook secret in source control, logs, shell history, or shared documentation. The configured webhook endpoint remains:

```text
https://api-pointffc.onrender.com/integracoes/telegram/webhook
```

The webhook returns `503` when a required Telegram send fails, so Telegram can retry the update. A query failure is handled separately: the bot sends a generic response, and that update is complete only if the response send succeeds. A send failure after part of a competition list does not trigger a generic query-error message.

Only fully processed `update_id` values are deduplicated. The process keeps at most 1,000 completed IDs in memory. This is best effort: entries disappear on restart, are not shared across multiple instances, and older IDs can be evicted. Telegram may retry a failed webhook only a limited number of times. If delivery fails after some list messages were accepted, a retry can repeat those earlier messages because Telegram `sendMessage` has no idempotency key in this integration. No durable delivery queue or cross-instance deduplication is implemented.

## Telegram account linking

In a private chat, select **🔗 Conectar minha conta** or send `/vincular` to receive a 48-character random hexadecimal code. The bot sends an instruction message, the code by itself in a `code` entity for easier copying, then a final message with an inline URL button to `https://pointffc.com.br/conectar-telegram/`. The main reply keyboard is marked persistent and remains available alongside the inline button. The code expires in 10 minutes and can be used once. The Telegram user ID comes from the authenticated Telegram webhook update; it is not accepted from the browser. The raw code is sent only to that private chat and is never stored or logged. The database stores its SHA-256 hash.

The free participation selection is kept in process memory, scoped by Telegram user ID, expires 10 minutes after the last interaction, and is capped at 1,000 sessions. A random session token and one-use keyboard nonce bind each callback to the current session; callback data stays below Telegram's 64-byte limit. Telegram user ID, private chat ID, and inline message ID must all match. A process restart or eviction clears the selection; the user must start again. Opening a competition loads the active link, FREE competition, owned teams, registrations, and limits into the session. Selection and pagination callbacks use that snapshot without database queries. On **Continue**, the API revalidates the active link, competition, owned teams, registrations, per-user limit, and active participant capacity. If eligibility changed, it clears the selection and asks the user to choose again with the refreshed list. Selections are sorted by Cartola team ID for deterministic summaries. This temporary state is not authorization to enroll; the flow stops at a summary that explicitly says no inscription was made.

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
