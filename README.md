# 💰 Finance Bot — Telegram Personal Finance Tracker (Local OCR)

A Telegram bot that logs income, expenses, and transfers directly into a Google Sheet, with receipt scanning (photo + PDF), a natural-language quick-add shortcut, and monthly recurring auto-transactions.

> **Branch note:** this is the `main` branch. Receipt reading here is done **locally** (Tesseract.js for photos, `pdf-parse` for PDFs) with regex-based extraction — no AI, no image/PDF data ever leaves your server except to Google Sheets. See the `ai-receipt-ocr` branch / `README-ai-ocr.md` for a version that sends receipts to Gemini instead, which is more accurate but sends the file to Google's API.

---

## Table of contents
- [What it does](#what-it-does)
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

Every transaction (income, expense, transfer) is written as a row into a **Google Sheet**, the same sheet you'd normally use to track finances by hand. The bot is just a fast, structured way to get data into that sheet from your phone — via buttons, a typed shorthand, a natural-language sentence, or a photo/PDF of a receipt.

It also supports **recurring transactions** (e.g. monthly salary) that insert themselves automatically on a schedule, no manual entry needed.

---

## Tech stack

| Piece | Technology |
|---|---|
| Bot framework | [Telegraf](https://telegraf.js.org/) (Telegram Bot API wrapper) + `telegraf/scenes` for multi-step conversations |
| Data store | Google Sheets, via `googleapis` (service account auth) |
| Image OCR | [Tesseract.js](https://github.com/naptha/tesseract.js) (fully local, no external API) |
| PDF text extraction | [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) |
| Natural-language text parsing | Google Gemini API (`gemini-3.6-flash`), **only** for the free-text chat shortcut — not for receipts |
| Recurring transactions | [`node-cron`](https://www.npmjs.com/package/node-cron) |
| Currency conversion | Google Sheets' native `GOOGLEFINANCE()` function, triggered via a formula the bot writes into each row |
| Runtime | Node.js |

---

## Architecture

```
index.js            → entry point; starts the bot + the auto-transaction scheduler
config.js           → loads .env into one object
bot.js               → all Telegram interaction: menus, wizards, message handlers
sheets.js            → all Google Sheets reads/writes (Transactions, Preferences, Main)
autotx.js            → CRUD for recurring-transaction rules (AutoTransactions sheet tab)
autoScheduler.js      → daily cron check that fires due recurring transactions
parser.js            → strict "description amount account" shorthand parser
categorizer.js        → keyword-based category + income/expense type guesser (free, no API)
ai.js                → Gemini call for natural-language text messages (optional, needs API key)
ocr.js               → photo receipt → text (Tesseract) → structured data
pdfOcr.js             → PDF receipt → text (pdf-parse) → structured data
receiptParsing.js      → shared regex logic: extract amount / merchant / account from raw text
logger.js             → timestamped console logging used everywhere
test-auto.js          → manual test harness for recurring transactions (see below)
```

---

## Feature flows

### 1. Manual entry (buttons)
```
Tap ➕ Income / ➖ Expense
  → bot asks for amount
  → bot asks for category (from your Preferences sheet)
  → bot asks for account (from your Preferences sheet)
  → bot asks for description (optional, "No description" button available)
  → row written to Transactions sheet
```
`🔁 Transfer` follows the same pattern but asks for a **from** account, a **to** account, and an optional **admin fee** (recorded as a separate expense row against the source account) before the description step.

### 2. Quick text shortcut (free, no AI)
Type e.g. `mcd 10000 cash` directly in the chat (no buttons needed):
```
"mcd 10000 cash"
  → parser.js splits it: description="mcd", amount=10000, account="cash"
  → categorizer.js guesses category/type from keywords (e.g. "mcd" → Restaurants, expense)
  → row written directly, no further questions asked
```
This never calls any AI — it's pure string parsing + a keyword lookup table in `categorizer.js`.

### 3. Natural-language text (optional, uses Gemini)
If your message **doesn't** match the strict shorthand above (e.g. `"Makan hari ini 40000 dari sea bank"`), the bot falls back to Gemini to extract the same fields (type, description, amount, category, account) from the full sentence. This only runs if `GEMINI_API_KEY` is set — otherwise you just get a "use the shorthand format" reply.

### 4. Photo receipt (local OCR)
```
Send a photo of a receipt
  → Tesseract.js OCRs the image to raw text
  → receiptParsing.js regex-extracts: amount (near "Total"/"Jumlah"/"Bayar"),
    merchant name (near "Restaurant location" or "... from" labels), and
    account (near "Paid with ...")
  → categorizer.js guesses a category from the merchant text
  → IF all 3 fields (amount, matched account, category) are confidently found:
        show a summary card → ✅ Confirm & Add (inserts immediately) or ✏️ Edit details
  → IF only some fields are found:
        enter the manual wizard, pre-filled with "✅ Use: <detected value>" buttons
        on every step where something was detected, so you only re-type what's wrong
```

### 5. PDF receipt (local text extraction)
Same flow as photos, but the source is a PDF's text layer via `pdf-parse` instead of Tesseract. **This only works on PDFs that already contain real text** (e-commerce invoices, digital receipts) — a scanned/photographed PDF has no text layer and will fall through to manual entry with a note explaining why.

### 6. Recurring / auto-transactions
```
Tap 🔁📅 Auto → ➕ Add auto-transaction
  → walks through type / description / amount / category / account / day-of-month
  → saved as a rule row in the AutoTransactions sheet tab (not the Transactions tab)

Every day at 07:00 (Asia/Jakarta):
  → autoScheduler.js reads all active rules
  → any rule whose "day of month" matches today AND hasn't already run today
    gets inserted into Transactions exactly like a manual entry, and you get
    a Telegram message confirming it
```
You can also **list**, **delete**, or **pause/resume** (toggle active) existing rules from the same `🔁📅 Auto` menu.

### 7. 💰 Available
Pulls "Available", "Daily available", "Total", and the per-account balances from your `Main` sheet tab and renders them as an aligned, monospace summary block in the chat (🟢/🔴 per account depending on sign).

---

## Google Sheet setup

Your spreadsheet needs these tabs (create manually once):

**`Transactions`** — header row: `Date | Description | Category | Amount | Account | In main currency`
Column F ("In main currency") is written by the bot as a live formula, not a static number, so it stays correct if you edit the amount later:
```
=ROUND(D{row} * IF(VLOOKUP(E{row}, Preferences!$H$4:$J$22, 3, FALSE) = Preferences!$F$16, 1, IFNA(GOOGLEFINANCE("CURRENCY:" & VLOOKUP(E{row}, Preferences!$H$4:$J$22, 3, FALSE) & Preferences!$F$16), 1)), 2)
```

**`Preferences`** — expense categories in column B, income categories in column C, accounts in column H, all starting at row 4 (rows above are headers). **Lists must be contiguous — a blank row ends the list**, since the bot stops reading at the first empty cell.

**`Main`** — your existing dashboard. The bot looks up the cells below the labels `Available`, `Total`, `Daily available`, and the block below `Accounts`, wherever they are on the sheet — no fixed cell references needed.

**`AutoTransactions`** (new tab, create with this exact header row in A1:J1):
```
ID | Type | Description | Amount | Category | Account | Day of Month | Active | Chat ID | Last Run
```
Leave everything below the header empty — the bot fills it in.

Your Google Cloud **service account** (the one behind `credentials.json` / `GOOGLE_CREDENTIALS_JSON`) needs Editor access to this spreadsheet, shared the same way you'd share it with any Google account.

---

## Environment variables

```
BOT_TOKEN=              # from @BotFather on Telegram
GOOGLE_SHEET_ID=         # the long ID in your spreadsheet's URL
GEMINI_API_KEY=          # optional — only needed for natural-language text parsing. Free tier, no card required (aistudio.google.com)

# Google Sheets auth — use ONE of these two:
# (A) local dev: keep a credentials.json service-account key file in the project root
# (B) deployment: paste the same file's content, minified to one line, as an env var:
GOOGLE_CREDENTIALS_JSON=
```
To generate the minified value for `GOOGLE_CREDENTIALS_JSON`:
```
node -e "console.log(JSON.stringify(require('./credentials.json')))"
```

---

## Local setup

```
npm install
cp .env.example .env   # fill in the values above
node index.js
```

---

## Deployment

This is a long-running process (Telegram long-polling + a daily cron job), so it needs a host that keeps a process alive 24/7 — not a serverless/on-demand platform. Two free options that work:

- **Render (free tier)** — easiest, but sleeps after ~15 min of inactivity. Pair with a free external pinger (e.g. cron-job.org) hitting a small `/ping` HTTP endpoint every ~10 minutes to keep it awake so the 07:00 cron doesn't get missed.
- **Oracle Cloud Always Free (ARM VM)** — genuinely never sleeps, more setup (you manage a real Linux VM with `pm2`).

Deploy from a specific git branch by changing the "Branch" setting in your host's dashboard (Render: Settings → Build & Deploy → Branch) — useful for testing feature branches like `ai-receipt-ocr` without touching production.

---

## Testing auto-transactions

You don't have to wait for 7am to test a recurring rule:
```
node test-auto.js                        # run as if today is the real date
node test-auto.js 2026-08-25             # simulate a specific date
node test-auto.js 2026-08-25 --dry       # simulate without writing anything or sending Telegram messages
node test-auto.js 2026-08-25 --force     # ignore "already ran today" so you can re-test the same date repeatedly
```

---

## How users connect / use the bot

This bot is built for **single-user, personal use** — it's wired to one Google Sheet and (via the auto-transaction "Chat ID" column) sends scheduled notifications back to whoever's chat ID created each rule. It isn't a multi-tenant service where strangers can sign up.

To use it yourself:
1. Open Telegram, search for your bot by the username you set with @BotFather.
2. Tap **Start** (or send `/start`).
3. Use the menu buttons, or just type transactions/send receipt photos directly.

If you want to share it with someone else (e.g. a partner tracking a shared budget), they'd talk to the same bot and it would write to the same spreadsheet — there's currently no per-user data separation.

---

## Known limitations

- Receipt reading is regex-based against known layouts (GoFood-style, generic "Total"/"Paid with" patterns). A completely new receipt format may need a new rule added to `receiptParsing.js`.
- PDF support only works on PDFs with a real text layer — scanned/photographed PDFs aren't supported (would need Ghostscript/GraphicsMagick + image rasterization, not currently included).
- The natural-language text shortcut and Gemini vision (AI-OCR branch) are billed against Gemini's free-tier daily quota, which Google can adjust without much notice.
