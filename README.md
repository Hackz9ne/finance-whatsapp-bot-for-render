# Anubis

Anubis is a WhatsApp bot that answers questions about Student Finance Wallet and the YourPay payment flow.

## What it does

- Starts the chat when a user sends `/start`
- Answers questions from your local YourPay docs file
- Tries to read the live site at `student-finance-wallet.42web.io`
- Falls back to the bundled knowledge file if the site is blocked or the docs file is unavailable

## Commands

- `/start` starts the bot for that user
- `/help` shows the command list
- `/source` shows the current knowledge source
- `/refresh` refreshes the knowledge cache

## Setup

1. Install dependencies:

```bash
npm install
```

2. Start the bot:

```bash
npm start
```

3. Scan the QR code shown in the terminal.

By default, the bot stores runtime data under `data/`, including WhatsApp auth files, QR artifacts, and chat logs.

## Configuration

Optional environment variables:

- `DATA_DIR`: base directory for persistent runtime storage
- `KNOWLEDGE_URL`: override the website URL used as the primary knowledge source
- `KNOWLEDGE_FILE_PATH`: override the local docs file path
- `OPENROUTER_API_KEY`: enables AI answers through OpenRouter
- `OPENROUTER_MODEL`: optional model name, defaults to `openrouter/free`

If `KNOWLEDGE_URL` is not set, Anubis tries these URLs in order:

1. `https://student-finance-wallet.42web.io`
2. `http://student-finance-wallet.42web.io`

If the site cannot be read, Anubis then uses:

1. `KNOWLEDGE_FILE_PATH` if set
2. [yourpay-docs.txt](/D:/whatsapp%20bot/knowledge/yourpay-docs.txt)
3. [DOCS.txt](/D:/finance%20app/payment_gateway/DOCS.txt)
4. [knowledge/student-finance-wallet.txt](/D:/whatsapp%20bot/knowledge/student-finance-wallet.txt)

## Notes

- The target website is hosted behind a JavaScript cookie challenge, so live scraping may fail depending on the host response.
- Because of that, the bundled knowledge file is the reliability fallback.
- Without `OPENROUTER_API_KEY`, the bot uses simple retrieval over the site or knowledge text.
- With `OPENROUTER_API_KEY`, the bot sends the relevant doc context to OpenRouter and uses the AI response, with a fallback to local retrieval if the API call fails.

## OpenRouter AI Mode

Set your OpenRouter key before starting the bot:

```powershell
$env:OPENROUTER_API_KEY="your_openrouter_key"
$env:OPENROUTER_MODEL="openrouter/free"
npm start
```

You can keep `OPENROUTER_MODEL` unset to use the default free router.

## Render Deployment

This repo includes [render.yaml](/D:/whatsapp%20bot/render.yaml) for a Render background worker with a persistent disk.

On Render:

- deploy as a `worker`, not a web service
- keep the disk mounted at `/opt/render/project/src/render-data`
- set `OPENROUTER_API_KEY` in the Render dashboard
- leave `DATA_DIR` as `/opt/render/project/src/render-data`

Persistent files on Render:

- WhatsApp auth: `render-data/session_data`
- chat logs: `render-data/chat_logs/messages.jsonl`
- QR artifacts: `render-data/artifacts`

## Files

- [index.js](/D:/whatsapp%20bot/index.js): WhatsApp bot runtime and retrieval logic
- [yourpay-docs.txt](/D:/whatsapp%20bot/knowledge/yourpay-docs.txt): bundled local knowledge source for Render and GitHub
- [DOCS.txt](/D:/finance%20app/payment_gateway/DOCS.txt): original local docs source
- [knowledge/student-finance-wallet.txt](/D:/whatsapp%20bot/knowledge/student-finance-wallet.txt): fallback knowledge base
- [package.json](/D:/whatsapp%20bot/package.json): project metadata and dependencies
- [render.yaml](/D:/whatsapp%20bot/render.yaml): Render worker and persistent disk blueprint

## License

This project is released under the MIT License. See [LICENSE](/D:/whatsapp%20bot/LICENSE).

## Copyright

Copyright (c) 2026 Anubis contributors
