# POINT FFC Connect: webhook

The menu uses a Telegram reply keyboard. Selecting **🏆 Ver competições** arrives as a regular private `message`, so this integration does not require `callback_query` in the webhook's `allowed_updates` list.

If Telegram's current webhook has a custom `allowed_updates` list that omits `message`, update it through the deployment's approved secret-management tooling. Keep the existing webhook URL and configured secret header value, and include `message` in `allowed_updates`, for example:

```json
{"allowed_updates":["message"]}
```

Do not put the bot token or webhook secret in source control, logs, shell history, or shared documentation. The configured webhook endpoint remains:

```text
https://api-pointffc.onrender.com/integracoes/telegram/webhook
```

The webhook returns `503` when a required Telegram send fails, so Telegram can retry the update. A query failure is handled separately: the bot sends a generic response, and that update is complete only if the response send succeeds. A send failure after part of a competition list does not trigger a generic query-error message.

Only fully processed `update_id` values are deduplicated. The process keeps at most 1,000 completed IDs in memory. This is best effort: entries disappear on restart, are not shared across multiple instances, and older IDs can be evicted. Telegram may retry a failed webhook only a limited number of times. If delivery fails after some list messages were accepted, a retry can repeat those earlier messages because Telegram `sendMessage` has no idempotency key in this integration. No durable delivery queue or cross-instance deduplication is implemented.
