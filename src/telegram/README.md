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

The webhook continues acknowledging a valid update even when a Telegram send fails. Send failures are logged with generic messages and without credentials. Duplicate `update_id` values are suppressed in process memory; this is best effort and does not persist across restarts or separate instances.
