# 💰 Finance Bot — Telegram Personal Finance Tracker (AI Receipt OCR)

A Telegram bot that logs income, expenses, and transfers directly into a Google Sheet, with receipt scanning (photo + PDF), a natural-language quick-add shortcut, and monthly recurring auto-transactions.

> **Branch note:** this is the `ai-receipt-ocr` branch. Receipt reading here sends the actual image/PDF bytes to **Gemini** (Google's multimodal AI) and asks it directly for the structured transaction — no local OCR engine, no hand-written regex per receipt template. This is more accurate and far more robust to new receipt formats than the `main` branch, at the cost of sending receipt files to Google's API and using more of your Gemini free-tier quota per receipt. See `README.md` (main branch) for the fully local version.

---

## Table of contents
- [What it does](#what-it-does)
- [What's different from `main`](#whats-different-from-main)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Feature flows](#feature-flows)
- [Google Sheet setup](#google-sheet-setup)
- [Environment variables](#environment-variables)
- [Local setup](#local-setup)
- [Deployment](#deployment)
- [Testing auto-transactions](#testing-auto-transactions)
- [How users connect / use the bot](#how-users-connect--use-the-bot)
- [Known limitations](#known-limitations)

---

## What it does

Every transaction (income, expense, transfer) is written as a row into a **Google Sheet**, the same sheet you'd normally use to track finances by hand. The bot is a fast way to get data into that sheet — via buttons, a typed shorthand, a natural-language sentence, or a photo/PDF of a receipt read directly by AI.

It also supports **recurring transactions** (e.g. monthly salary) that insert themselves automatically on a schedule, no manual entry needed.

---

## What's different from `main`

| | `main` (local OCR) | `ai-receipt-ocr` (this branch) |
|---|---|---|
| Photo receipts | Tesseract.js → regex extraction | Sent directly to Gemini as image bytes |
| PDF receipts | `pdf-parse` (text layer only) → regex extraction | Sent directly to Gemini as PDF bytes — works even on receipts local text-extraction fails on |
| New receipt layouts | Needs a new rule added to `receiptParsing.js` | Handled automatically — Gemini reads it like a person would |
| Category on receipts | Guessed from merchant name via keyword list | Chosen directly by Gemini from your actual category list |
| Data sent externally | None (fully local) | Receipt image/PDF bytes sent to Google's Gemini API |
| Gemini quota usage | Only for natural-language *text* messages (small) | Text messages **and** every receipt photo/PDF (images/PDFs use much more of the daily free-tier quota per call) |
| Fallback if no `GEMINI_API_KEY` | N/A (text shortcut just doesn't parse natural sentences) | Falls back to the same local Tesseract/`pdf-parse` pipeline as `main` |

Everything else — manual entry wizards, the shorthand parser, transfers, admin fees, auto-transactions, the Available summary — is identical between branches.

---

## Tech stack

| Piece | Technology |
|---|---|
| Bot framework | [Telegraf](https://telegraf.js.org/) + `telegraf/scenes` |
| Data store | Google Sheets, via `googleapis` (service account auth) |
| Receipt reading (photo + PDF) | Google **Gemini** multimodal API (`gemini-3.6-flash`), reading raw image/PDF bytes directly |
| Fallback receipt reading | Tesseract.js (photos) / `pdf-parse` (PDFs) — used only if no `GEMINI_API_KEY` or the AI call fails |
| Natural-language text parsing | Same Gemini API, text-only prompt |
| Recurring transactions | [`node-cron`](https://www.npmjs.com/package/node-cron) |
| Currency conversion | Google Sheets' native `GOOGLEFINANCE()`, via a formula written into each row |
| Runtime | Node.js |

---

## Architecture

```
index.js               → entry point; starts the bot + the auto-transaction scheduler
config.js               → loads .env into one object
bot.js                  → all Telegram interaction: menus, wizards, message handlers
sheets.js               → all Google Sheets reads/writes (Transactions, Preferences, Main)
autotx.js               → CRUD for recurring-transaction rules (AutoTransactions sheet tab)
autoScheduler.js         → daily cron check that fires due recurring transactions
parser.js               → strict "description amount account" shorthand parser
categorizer.js           → keyword-based category/type guesser (used by the shorthand path and as a fallback)
ai.js                   → Gemini call for natural-language TEXT messages
aiReceipt.js             → Gemini call for RECEIPT images/PDFs (multimodal) — new in this branch
ocr.js / pdfOcr.js        → local fallback receipt readers, used only if Gemini is unavailable
receiptParsing.js         → shared regex logic used by the local fallback path
logger.js                → timestamped console logging used everywhere
test-auto.js              → manual test harness for recurring transactions (see below)
```

---

## Feature flows

### 1–3. Manual entry, quick text shortcut, natural-language text
Identical to `main` — see that README for the full breakdown. Briefly: buttons walk you through a wizard; `"mcd 10000 cash"` is parsed locally for free; anything else typed falls back to Gemini text parsing.

### 4. Photo receipt (AI)
```
Send a photo of a receipt
  → image bytes sent directly to Gemini with your real category/account lists
  → Gemini returns: amount, merchant description, best-fit category, and
    account (if the payment method is identifiable, e.g. "Paid with GoPay")
  → IF Gemini confidently returns everything:
        show a summary card → ✅ Confirm & Add (inserts immediately) or ✏️ Edit details
  → IF Gemini can't confidently fill every field, or GEMINI_API_KEY isn't set:
        falls back to the local Tesseract pipeline (same behavior as `main`)
```
No template-specific rules needed — a completely new receipt layout (a different delivery app, a retail receipt, a bank transfer confirmation) works out of the box, since Gemini is reading it contextually rather than pattern-matching known label text.

### 5. PDF receipt (AI)
Same as photos, but the PDF's raw bytes are sent to Gemini directly — this also correctly handles PDFs with no extractable text layer (scanned/photographed PDFs), which the local `pdf-parse` fallback cannot.

### 6. Recurring / auto-transactions, 7. Available
Identical to `main` — see that README for the full flow.

---

## Google Sheet setup

Identical to `main` — same `Transactions`, `Preferences`, `Main`, and `AutoTransactions` tab structure and the same column-F currency formula. See the `main` branch README for the exact header rows and formula.

---

## Environment variables

```
BOT_TOKEN=              # from @BotFather on Telegram
GOOGLE_SHEET_ID=         # the long ID in your spreadsheet's URL
GEMINI_API_KEY=          # required for AI receipt reading in this branch. Without it, receipts
                        # silently fall back to the local Tesseract/pdf-parse pipeline.
                        # Free tier, no card required (aistudio.google.com)

# Google Sheets auth — use ONE of these two:
GOOGLE_CREDENTIALS_JSON=  # deployment: minified service-account JSON as one env var
# or keep a credentials.json file in the project root for local dev
```
To generate the minified value for `GOOGLE_CREDENTIALS_JSON`:
```
node -e "console.log(JSON.stringify(require('./credentials.json')))"
```

---

## Local setup

```
npm install
cp .env.example .env   # fill in the values above, especially GEMINI_API_KEY
node index.js
```

---

## Deployment

Same requirements as `main` — a host that keeps a process alive 24/7 (long-polling + daily cron), not serverless. See the `main` branch README for the Render / Oracle Cloud options and how to point your host at this specific branch.

Because this branch calls Gemini on every receipt (not just occasional text messages), keep an eye on daily quota usage if you're sending many receipts — if receipts start silently falling back to the local OCR pipeline more than expected, check whether you've hit the free-tier daily cap before assuming it's a bug.

---

## Testing auto-transactions

Same as `main`:
```
node test-auto.js                        # run as if today is the real date
node test-auto.js 2026-08-25             # simulate a specific date
node test-auto.js 2026-08-25 --dry       # simulate without writing anything or sending Telegram messages
node test-auto.js 2026-08-25 --force     # ignore "already ran today" so you can re-test the same date repeatedly
```

---

## How users connect / use the bot

Same as `main` — this is a **single-user, personal-use bot** wired to one Google Sheet, not a multi-tenant service:
1. Open Telegram, search for your bot's username.
2. Tap **Start** (or send `/start`).
3. Use the menu buttons, type transactions directly, or send a receipt photo/PDF.

---

## Known limitations

- Receipt reading now depends on Gemini being reachable and within quota — if both the API call fails *and* the local fallback OCR also can't extract enough, you'll be asked to enter details manually (same graceful degradation as `main`).
- Sending receipt images/PDFs to a third-party API is a meaningful difference from `main` if data privacy of your spending habits/receipts matters to you — worth being aware of before merging this branch into production.
- Gemini free-tier quotas can be adjusted by Google with little notice; heavier receipt volume will hit limits faster than the text-only usage in `main`.
