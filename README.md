# WhatsApp Bridge (Baileys)

Small HTTP service that sits between your Laravel app and WhatsApp. Each session
maps to one WhatsApp login and forwards events to a webhook you control.

## Setup

```bash
yarn install
cp .env.example .env
# Set API_KEY (and optionally AUTH_PASSWORD) before starting the service.
yarn start
```

Open `http://localhost:3000/` to use the dashboard. The dashboard and all
management API routes use the dashboard login configured through `AUTH_USERNAME`
and `AUTH_PASSWORD`. If `AUTH_PASSWORD` is omitted, `API_KEY` is accepted as the
dashboard password. If both are omitted, local dashboard authentication is disabled.

Application logs are written to stdout and to `LOG_FILE` (defaults to
`./logs/app.log`). Authenticated users can also inspect the latest entries from
the **سجل المشاكل** tab in the dashboard.

## API

The Laravel-compatible API keeps the same unprefixed URLs as the deployed bridge:

- `POST /sessions/:id/connect`
- `POST /sessions/:id/pair`
- `POST /sessions/:id/send`
- `POST /sessions/:id/send-image`
- `POST /sessions/:id/send-poll`
- `POST /sessions/:id/send-buttons`
- `POST /sessions/:id/send-interactive`
- `POST /sessions/:id/send-bulk`
- `GET /sessions`
- `GET /sessions/:id`
- `GET /sessions/:id/qr`
- `DELETE /sessions/:id`
- `GET /health`

When `API_KEY` is configured, send it as `X-API-Key: <key>` or
`Authorization: Bearer <key>`. The dashboard's existing `/api/...` routes remain
available for backward compatibility with the current UI.

### Connect (QR or Pair)

`webhookUrl` is optional, matching the deployed bridge. When provided, the
service stores it with the session and uses it for future events. Use
`reset: true` to wipe saved auth state and start fresh.

```bash
curl -X POST http://localhost:3000/sessions/demo/connect \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"mode":"qr","waitMs":15000,"webhookUrl":"https://your-laravel-app.test/webhooks/whatsapp","webhookSecret":"optional-secret","reset":true}'
```

```bash
curl -X POST http://localhost:3000/sessions/demo/connect \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"mode":"pair","phoneNumber":"201234567890","webhookUrl":"https://your-laravel-app.test/webhooks/whatsapp","webhookSecret":"optional-secret","reset":true}'
```

### Send message

```bash
curl -X POST http://localhost:3000/sessions/demo/send \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"to":"201234567890","message":"Hello from Laravel"}'
```

### Send poll

```bash
curl -X POST http://localhost:3000/sessions/demo/send-poll \
  -H "Content-Type: application/json" \
  -d '{"to":"201234567890","name":"Pick a delivery slot","options":["10am","2pm","6pm"],"selectableCount":1}'
```

### Send buttons

```bash
curl -X POST http://localhost:3000/sessions/demo/send-buttons \
  -H "Content-Type: application/json" \
  -d '{"to":"201234567890","text":"Choose an option","buttons":[{"id":"opt1","text":"Option 1"},{"id":"opt2","text":"Option 2"}],"footer":"Footer text"}'
```

### Send interactive message

`buttonParamsJson` can be a JSON object in the request body.

```bash
curl -X POST http://localhost:3000/sessions/demo/send-interactive \
  -H "Content-Type: application/json" \
  -d '{"to":"201234567890","text":"Pick one","footer":"Footer text","interactiveButtons":[{"name":"quick_reply","buttonParamsJson":{"display_text":"Yes","id":"yes"}},{"name":"cta_url","buttonParamsJson":{"display_text":"Open website","url":"https://example.com"}}]}'
```

## Webhook

Each session may provide a `webhookUrl` and optional `webhookSecret` on the
connect request. Sessions without a webhook still connect, but incoming events
are not forwarded.

The server adds an `eventId` to each webhook payload and sends the same value in
the `x-event-id` header. A short in-memory idempotency cache suppresses duplicate
events inside a time window (defaults to 10 minutes). Tune with
`IDEMPOTENCY_TTL_MS` and `IDEMPOTENCY_MAX_KEYS`.

`eventId` is a SHA-256 hash of stable fields per event type (for example:
`connection_update` uses connection/status/QR hash, `message_update` uses
messageId + status).

Poll vote aggregation relies on an in-memory message store for `getMessage`.
Adjust retention with `MESSAGE_STORE_TTL_MS` and `MESSAGE_STORE_MAX`.

### Webhook events

- `connection_update`: connection state changes, with `qr` when available
- `connection_update` also includes `phoneNumber` and `userJid` once connected
- `message`: inbound messages (includes `messageType` and `text`)
- `button_reply`: button replies (legacy or template)
- `list_reply`: list replies
- `poll`: poll creation with name and options
- `poll_vote`: decrypted poll votes, plus an aggregate tally
- `message_update`: delivery/read/status updates

Each event includes `sessionId` and is delivered to the webhook URL saved for the session.

## Session persistence

Auth state is stored under `data/sessions/<sessionId>` so logins survive restarts.
On startup, the server scans that directory and reconnects any existing sessions.
