// bot.js — Vercel (webhook) version
const { Telegraf, Scenes, session, Markup } = require("telegraf");

const {
  insertTransaction,
  insertTransfer,
  getExpenseCategories,
  getIncomeCategories,
  getAccounts,
  getAvailableSummary,
  getBudgetSummary
} = require("./sheets");

const { extractReceiptDataFromPDF } = require("./pdfOcr");
const { analyzeReceiptWithAI } = require("./aiReceipt");
const { parseIndoAmount, parseFreeText, looksLikeMoney } = require("./chatParser");
const { guessTransaction } = require("./categorizer");
const { parseWithAI } = require("./ai");
const { listAutoTransactions, addAutoTransaction, deleteAutoTransaction, setActive } = require("./autotx");
const sessionStore = require("./sessionStore");
const { now } = require("./time");
const logger = require("./logger");

const CANCEL = "❌ Cancel";
const NO_DESCRIPTION = "⏭ No description";
const NO_FEE = "🆓 No fee";
const CONFIRM = "✅ Confirm & Add";
const EDIT = "✏️ Edit details";
const AUTO_MENU = "🔁📅 Auto";
const AUTO_ADD = "➕ Add auto-transaction";
const AUTO_DELETE = "🗑 Delete one";
const AUTO_TOGGLE = "⏸️▶️ Toggle active";
const AUTO_BACK = "⬅️ Back";
const BUDGET_VIEW = "📊 Budget";
const PREV_MONTH = "◀ Previous";
const NEXT_MONTH = "Next ▶";
const BUDGET_BACK = "⬅️ Back";

const mainKeyboard = Markup.keyboard([
  ["➕ Income", "➖ Expense"],
  ["🔁 Transfer"],
  ["💰 Available", BUDGET_VIEW],
  [AUTO_MENU]
]).resize();

// Understands 25000, 5.000, 25rb, 2k, 7jt, 1,5jt, Rp 5.000 ...
function parseAmount(text) {
  return parseIndoAmount(text);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function optionKeyboard(options) {
  return Markup.keyboard([...chunk(options, 2), [CANCEL]]).resize();
}

function formatIDR(n) {
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

async function downloadBuffer(url) {
  const t = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) }); // never hang on a slow download
  const arrayBuffer = await res.arrayBuffer();
  logger.info(`Downloaded file: ${arrayBuffer.byteLength} bytes in ${Date.now() - t}ms`);
  return Buffer.from(arrayBuffer);
}

// A short "reading..." message so a slow AI never looks like a dead bot (and you don't re-send the photo).
async function sendAck(ctx, text) {
  try {
    return await ctx.reply(text);
  } catch (err) {
    logger.warn("Couldn't send the 'reading' message:", err.message);
    return null;
  }
}

async function clearAck(ctx, ack) {
  if (!ack) return;
  try {
    await ctx.deleteMessage(ack.message_id);
  } catch (err) {
    /* already deleted or too old — nothing to do */
  }
}

// ---------- Auto-transaction list (same look as the Available summary) ----------

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(text, max) {
  const t = String(text ?? "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// 🟢 active income   🔴 active expense   ⏸️ paused
function renderAutoList(list) {
  if (!list.length) {
    return "<b>🔁 Auto Transactions</b>\nNo auto-transactions yet. Tap ➕ to add one.";
  }

  const active = list.filter(a => a.active);
  const sum = type => active.filter(a => (a.type === "income") === (type === "income")).reduce((n, a) => n + a.amount, 0);

  const summaryBlock = [
    `Income/month   Rp ${formatIDR(sum("income"))}`,
    `Expense/month  Rp ${formatIDR(sum("expense"))}`
  ].join("\n");

  const nameWidth = Math.min(Math.max(...list.map(a => a.description.length), 4), 20) + 1;
  const ruleLines = list.map(a => {
    const emoji = !a.active ? "⏸️" : a.type === "income" ? "🟢" : "🔴";
    const top = `${emoji} ${clip(a.description, 20).padEnd(nameWidth)}Rp ${formatIDR(a.amount).padStart(10)}`;
    const bottom = `   day ${a.dayOfMonth} · ${clip(a.category, 16)} → ${clip(a.account, 9)}`;
    return `${escapeHtml(top)}\n${escapeHtml(bottom)}`;
  });

  return `<b>🔁 Auto Transactions</b>\n<pre>${summaryBlock}\n\nRULES\n${ruleLines.join("\n")}</pre>`;
}

// ---------- Budget rendering ----------

function truncateName(name, width) {
  return name.length > width ? name.slice(0, width - 1) + "…" : name.padEnd(width);
}

function statusSymbol(r) {
  if (r.actual === 0) return "";
  if (r.diff > 0) return "🟢";
  if (r.diff < 0) return "🔴";
  return "⚪";
}

function renderBudget(summary) {
  const NAME_W = 12;
  const AMT_W = 10;

  function tableRows(rows) {
    return rows
      .filter(r => r.actual !== 0)
      .map(r => `${truncateName(r.name, NAME_W)}${formatIDR(r.actual).padStart(AMT_W)} ${statusSymbol(r)}`)
      .join("\n");
  }

  function notYet(rows) {
    const names = rows.filter(r => r.actual === 0 && r.plan !== 0).map(r => r.name);
    return names.length ? `<i>Not yet recorded (${names.length}): ${names.join(", ")}</i>` : "";
  }

  const header = `${"".padEnd(NAME_W)}${"Actual".padStart(AMT_W)}`;

  const block = [
    "INCOME",
    header,
    tableRows(summary.income) || "(none yet)",
    summary.totalIncome ? `${"TOTAL".padEnd(NAME_W)}${formatIDR(summary.totalIncome.actual).padStart(AMT_W)}` : "",
    "",
    "EXPENSES",
    header,
    tableRows(summary.expenses) || "(none yet)",
    summary.totalExpenses ? `${"TOTAL".padEnd(NAME_W)}${formatIDR(summary.totalExpenses.actual).padStart(AMT_W)}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const lines = [`<b>📊 Budget — ${summary.monthLabel}</b>`, `<pre>${block}</pre>`];

  const incomeFootnote = notYet(summary.income);
  const expenseFootnote = notYet(summary.expenses);
  if (incomeFootnote) lines.push(incomeFootnote);
  if (expenseFootnote) lines.push(expenseFootnote);

  if (summary.profit !== null) {
    lines.push(`<b>Profit:</b> Rp ${formatIDR(summary.profit)}`);
  }

  return lines.join("\n");
}

// ---------- Income / Expense wizard ----------
// Every step supports a "detected*" value in scene.state (from AI/OCR). If present,
// a "✅ Use: ..." button is offered, but the user can always type their own value.

const enterAmountStep = async ctx => {
  const detected = ctx.scene.state.detectedAmount;
  const buttons = detected ? [[`✅ Use: Rp ${formatIDR(detected)}`], [CANCEL]] : [[CANCEL]];
  await ctx.reply(`Specify an amount of ${ctx.scene.state.type}`, Markup.keyboard(buttons).resize());
  return ctx.wizard.next();
};

const amountStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL || text.toLowerCase() === "cancel") {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const useMatch = text.match(/^✅\s*Use:\s*Rp\s*([\d.,]+)$/i);
  const amount = useMatch ? Number(useMatch[1].replace(/[.,]/g, "")) : parseAmount(text);
  if (!amount) {
    return ctx.reply("Specify an amount (e.g. 25000, 25rb, 1,5jt), or tap ❌ Cancel");
  }
  ctx.scene.state.amount = amount;

  const categories =
    ctx.scene.state.type === "income" ? await getIncomeCategories() : await getExpenseCategories();
  ctx.scene.state.categories = categories;

  const detectedCategory = ctx.scene.state.detectedCategory;
  const options =
    detectedCategory && categories.includes(detectedCategory)
      ? [`✅ Use: ${detectedCategory}`, ...categories.filter(c => c !== detectedCategory)]
      : categories;

  await ctx.reply(`Specify a category of ${ctx.scene.state.type}`, optionKeyboard(options));
  return ctx.wizard.next();
};

const categoryStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const cleaned = text.replace(/^✅\s*Use:\s*/i, "").trim();
  const match = (ctx.scene.state.categories || []).find(c => c.toLowerCase() === cleaned.toLowerCase());
  if (!match) return ctx.reply("Pick a category from the keyboard.");
  ctx.scene.state.category = match;

  const accounts = await getAccounts();
  ctx.scene.state.accounts = accounts;

  const detectedAccount = ctx.scene.state.detectedAccount;
  const options =
    detectedAccount && accounts.includes(detectedAccount)
      ? [`✅ Use: ${detectedAccount}`, ...accounts.filter(a => a !== detectedAccount)]
      : accounts;

  await ctx.reply("Specify an account", optionKeyboard(options));
  return ctx.wizard.next();
};

const accountStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const cleaned = text.replace(/^✅\s*Use:\s*/i, "").trim();
  const match = (ctx.scene.state.accounts || []).find(a => a.toLowerCase() === cleaned.toLowerCase());
  if (!match) return ctx.reply("Pick an account from the keyboard.");
  ctx.scene.state.account = match;

  const detectedDescription = ctx.scene.state.detectedDescription;
  const buttons = detectedDescription
    ? [[`✅ Use: ${detectedDescription}`], [NO_DESCRIPTION], [CANCEL]]
    : [[NO_DESCRIPTION], [CANCEL]];

  await ctx.reply("Specify a description", Markup.keyboard(buttons).resize());
  return ctx.wizard.next();
};

const descriptionStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const useMatch = text.match(/^✅\s*Use:\s*(.+)$/i);
  const description = useMatch
    ? useMatch[1].trim()
    : text === NO_DESCRIPTION || text.toLowerCase() === "skip"
    ? ""
    : text;

  const { amount, category, account, type } = ctx.scene.state;
  logger.info("Inserting transaction (wizard):", { amount, category, account, type, description });
  const signed = await insertTransaction({ description, category, amount, account, type });

  await ctx.reply(`👍 Successfully added ${signed}.0 to ${category} from ${account}!`, mainKeyboard);
  return ctx.scene.leave();
};

const incomeExpenseWizard = new Scenes.WizardScene(
  "INCOME_EXPENSE_WIZARD",
  enterAmountStep,
  amountStep,
  categoryStep,
  accountStep,
  descriptionStep
);

// ---------- Transfer wizard ----------

const enterTransferAmountStep = async ctx => {
  await ctx.reply("Specify an amount to transfer", Markup.keyboard([[CANCEL]]).resize());
  return ctx.wizard.next();
};

const transferAmountStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL || text.toLowerCase() === "cancel") {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const amount = parseAmount(text);
  if (amount === null) return ctx.reply("Specify an amount (e.g. 25000, 25rb, 1,5jt), or tap ❌ Cancel");
  ctx.scene.state.amount = amount;

  const accounts = await getAccounts();
  ctx.scene.state.accounts = accounts;
  await ctx.reply("Transfer from which account?", optionKeyboard(accounts));
  return ctx.wizard.next();
};

const transferFromStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const match = (ctx.scene.state.accounts || []).find(a => a.toLowerCase() === text.toLowerCase());
  if (!match) return ctx.reply("Pick an account from the keyboard.");
  ctx.scene.state.fromAccount = match;

  const toOptions = ctx.scene.state.accounts.filter(a => a !== match);
  await ctx.reply("Transfer to which account?", optionKeyboard(toOptions));
  return ctx.wizard.next();
};

const transferToStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const match = (ctx.scene.state.accounts || []).find(a => a.toLowerCase() === text.toLowerCase());
  if (!match || match === ctx.scene.state.fromAccount) {
    return ctx.reply("Pick a different account from the keyboard.");
  }
  ctx.scene.state.toAccount = match;
  await ctx.reply("Any admin fee for this transfer?", Markup.keyboard([[NO_FEE], [CANCEL]]).resize());
  return ctx.wizard.next();
};

const transferFeeStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  if (text === NO_FEE) {
    ctx.scene.state.fee = 0;
  } else {
    const fee = parseAmount(text);
    if (fee === null) return ctx.reply("Specify the admin fee amount, or tap 🆓 No fee");
    ctx.scene.state.fee = fee;
  }
  await ctx.reply("Specify a description", Markup.keyboard([[NO_DESCRIPTION], [CANCEL]]).resize());
  return ctx.wizard.next();
};

const transferDescriptionStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const description = text === NO_DESCRIPTION || text.toLowerCase() === "skip" ? "" : text;
  const { amount, fromAccount, toAccount, fee } = ctx.scene.state;

  logger.info("Inserting transfer:", { amount, fromAccount, toAccount, fee, description });
  await insertTransfer({ description, amount, fromAccount, toAccount, fee });

  const feeNote = fee ? ` (admin fee: Rp ${formatIDR(fee)})` : "";
  await ctx.reply(`👍 Transferred Rp ${formatIDR(amount)} from ${fromAccount} to ${toAccount}!${feeNote}`, mainKeyboard);
  return ctx.scene.leave();
};

const transferWizard = new Scenes.WizardScene(
  "TRANSFER_WIZARD",
  enterTransferAmountStep,
  transferAmountStep,
  transferFromStep,
  transferToStep,
  transferFeeStep,
  transferDescriptionStep
);

// ---------- Receipt confirm wizard (only used when we got EVERYTHING confidently) ----------

const ocrConfirmStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  if (text === CONFIRM) {
    const { amount, description, category, account } = ctx.scene.state;
    logger.info("Receipt confirmed as-is, inserting:", { amount, description, category, account });
    const signed = await insertTransaction({ description, category, amount, account, type: "expense" });
    await ctx.reply(`👍 Successfully added ${signed}.0 to ${category} from ${account}!`, mainKeyboard);
    return ctx.scene.leave();
  }
  if (text === EDIT) {
    const { amount, description, category, account } = ctx.scene.state;
    logger.info("User chose to edit receipt-extracted data");
    await ctx.reply("Confirm or override each field below.");
    await ctx.scene.enter("INCOME_EXPENSE_WIZARD", {
      type: "expense",
      detectedAmount: amount,
      detectedDescription: description,
      detectedAccount: account,
      detectedCategory: category
    });
    return;
  }
  return ctx.reply("Please tap one of the buttons.");
};

const ocrConfirmWizard = new Scenes.WizardScene("OCR_CONFIRM_WIZARD", ocrConfirmStep);

// ---------- Auto-transaction wizards ----------

const autoTypeStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) { await ctx.reply("Cancelled.", mainKeyboard); return ctx.scene.leave(); }
  if (!["Income", "Expense"].includes(text)) return ctx.reply("Pick a type from the keyboard.");
  ctx.scene.state.type = text.toLowerCase();
  await ctx.reply('Description (e.g. "Salary")', Markup.keyboard([[CANCEL]]).resize());
  return ctx.wizard.next();
};

const autoDescStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) { await ctx.reply("Cancelled.", mainKeyboard); return ctx.scene.leave(); }
  ctx.scene.state.description = text;
  await ctx.reply("Amount", Markup.keyboard([[CANCEL]]).resize());
  return ctx.wizard.next();
};

const autoAmountStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) { await ctx.reply("Cancelled.", mainKeyboard); return ctx.scene.leave(); }
  const amount = parseAmount(text);
  if (!amount) return ctx.reply("Specify a valid amount (e.g. 25000, 25rb, 1,5jt), or tap ❌ Cancel");
  ctx.scene.state.amount = amount;
  const categories = ctx.scene.state.type === "income" ? await getIncomeCategories() : await getExpenseCategories();
  ctx.scene.state.categories = categories;
  await ctx.reply("Category", optionKeyboard(categories));
  return ctx.wizard.next();
};

const autoCategoryStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) { await ctx.reply("Cancelled.", mainKeyboard); return ctx.scene.leave(); }
  const match = (ctx.scene.state.categories || []).find(c => c.toLowerCase() === text.toLowerCase());
  if (!match) return ctx.reply("Pick a category from the keyboard.");
  ctx.scene.state.category = match;
  const accounts = await getAccounts();
  ctx.scene.state.accounts = accounts;
  await ctx.reply("Account", optionKeyboard(accounts));
  return ctx.wizard.next();
};

const autoAccountStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) { await ctx.reply("Cancelled.", mainKeyboard); return ctx.scene.leave(); }
  const match = (ctx.scene.state.accounts || []).find(a => a.toLowerCase() === text.toLowerCase());
  if (!match) return ctx.reply("Pick an account from the keyboard.");
  ctx.scene.state.account = match;
  await ctx.reply("Which day of the month should this run? (1-31)", Markup.keyboard([[CANCEL]]).resize());
  return ctx.wizard.next();
};

const autoDayStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) { await ctx.reply("Cancelled.", mainKeyboard); return ctx.scene.leave(); }
  const day = parseInt(text, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) return ctx.reply("Enter a day between 1 and 31, or tap ❌ Cancel");

  const { type, description, amount, category, account } = ctx.scene.state;
  await addAutoTransaction({ type, description, amount, category, account, dayOfMonth: day, chatId: ctx.chat.id });
  logger.info("Auto-transaction created via wizard:", { type, description, amount, category, account, day, chatId: ctx.chat.id });
  await ctx.reply(
    `✅ Auto-transaction saved: "${description}" — Rp ${formatIDR(amount)} → ${category} (${account}) every month on day ${day}.`,
    mainKeyboard
  );
  return ctx.scene.leave();
};

const autoTxAddWizard = new Scenes.WizardScene(
  "AUTO_TX_ADD_WIZARD",
  async ctx => { await ctx.reply("Type?", Markup.keyboard([["Income", "Expense"], [CANCEL]]).resize()); return ctx.wizard.next(); },
  autoTypeStep,
  autoDescStep,
  autoAmountStep,
  autoCategoryStep,
  autoAccountStep,
  autoDayStep
);

const autoPickStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) { await ctx.reply("Cancelled.", mainKeyboard); return ctx.scene.leave(); }
  const match = text.match(/^(\d+)\./);
  if (!match) return ctx.reply("Tap one of the numbered options.");
  const item = ctx.scene.state.list[parseInt(match[1], 10) - 1];
  if (!item) return ctx.reply("Tap one of the numbered options.");

  if (ctx.scene.state.action === "delete") {
    await deleteAutoTransaction(item.id);
    await ctx.reply(`🗑 Deleted "${item.description}".`, mainKeyboard);
  } else {
    await setActive(item.id, !item.active);
    await ctx.reply(`${!item.active ? "▶️ Activated" : "⏸️ Paused"} "${item.description}".`, mainKeyboard);
  }
  return ctx.scene.leave();
};

const autoTxPickWizard = new Scenes.WizardScene(
  "AUTO_TX_PICK_WIZARD",
  async ctx => {
    const list = await listAutoTransactions();
    ctx.scene.state.list = list;
    if (!list.length) {
      await ctx.reply("No auto-transactions set up yet.", mainKeyboard);
      return ctx.scene.leave();
    }
    const labels = list.map((a, i) => `${i + 1}. ${a.description} — Rp ${formatIDR(a.amount)} (${a.active ? "active" : "paused"})`);
    await ctx.reply(`Which one? (${ctx.scene.state.action})`, optionKeyboard(labels));
    return ctx.wizard.next();
  },
  autoPickStep
);

// ---------- Budget view wizard ----------

const budgetKeyboard = Markup.keyboard([[PREV_MONTH, NEXT_MONTH], [BUDGET_BACK]]).resize();

const budgetNavStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === BUDGET_BACK) {
    await ctx.reply("Main menu", mainKeyboard);
    return ctx.scene.leave();
  }
  let { offset } = ctx.scene.state;
  if (text === PREV_MONTH) offset -= 1;
  else if (text === NEXT_MONTH) offset += 1;
  else return;
  ctx.scene.state.offset = offset;

  const targetDate = now().add(offset, "month").startOf("month");
  logger.info(`Budget view: offset ${offset} (${targetDate.format("YYYY-MM")})`);
  const summary = await getBudgetSummary(targetDate);

  await ctx.replyWithHTML(renderBudget(summary), budgetKeyboard);
};

const budgetViewWizard = new Scenes.WizardScene(
  "BUDGET_VIEW_WIZARD",
  async ctx => {
    ctx.scene.state.offset = 0;
    const targetDate = now().startOf("month");
    logger.info(`Budget view: opening current month (${targetDate.format("YYYY-MM")})`);
    const summary = await getBudgetSummary(targetDate);
    await ctx.replyWithHTML(renderBudget(summary), budgetKeyboard);
    return ctx.wizard.next();
  },
  budgetNavStep
);

// ---------- Quick-add: "which account?" (used when a chat message had no account) ----------

const quickAccountWizard = new Scenes.WizardScene(
  "QUICK_ACCOUNT_WIZARD",
  async ctx => {
    const { accounts, amount, type } = ctx.scene.state;
    await ctx.reply(`Which account for the ${type} of Rp ${formatIDR(amount)}?`, optionKeyboard(accounts));
    return ctx.wizard.next();
  },
  async ctx => {
    const text = ctx.message?.text?.trim();
    if (!text) return;
    if (text === CANCEL) {
      await ctx.reply("Cancelled.", mainKeyboard);
      return ctx.scene.leave();
    }
    const match = (ctx.scene.state.accounts || []).find(a => a.toLowerCase() === text.toLowerCase());
    if (!match) return ctx.reply("Pick an account from the keyboard.");

    const { type, description, amount, category } = ctx.scene.state;
    logger.info("Quick-add inserting (account picked):", { type, description, amount, category, account: match });
    await insertTransaction({ description, category, amount, account: match, type });
    await ctx.reply(addedMessage({ type, amount, category, account: match, description }), mainKeyboard);
    return ctx.scene.leave();
  }
);

// ---------- Free-form chat ----------

const CHAT_HELP =
  'I couldn\'t find an amount in that. Try e.g. "makan siang 25rb cash", "gaji 7jt bri", "Cash 5000 gorengan" — or use the buttons.';

function addedMessage({ type, amount, category, account, description }) {
  return `👍 Added ${type} Rp ${formatIDR(amount)} → ${category} (${account})${description ? ` — ${description}` : ""}`;
}

async function safeParseAI(text, lists) {
  try {
    return await parseWithAI(text, lists);
  } catch (err) {
    logger.error("AI text parse threw unexpectedly:", err);
    return null;
  }
}

// Order of attack (cheapest first):
//   1. Local parser finds amount (7jt / 25rb / 5000 ...) and account anywhere in the sentence.
//   2. Local keyword rules pick the category. Only if they're unsure (nothing matched)
//      do we ask Gemini — and we keep the local amount/account either way.
//   3. If the local parser can't find a usable amount, Gemini reads the whole message.
//   4. If no account was named, ask for one with a single tap.
async function handleChatText(ctx, text) {
  logger.info(`Text from user ${ctx.from?.id}:`, text);

  const [accounts, incomeCategories, expenseCategories] = await Promise.all([
    getAccounts(),
    getIncomeCategories(),
    getExpenseCategories()
  ]);
  const lists = { accounts, incomeCategories, expenseCategories };

  const local = parseFreeText(text, accounts);
  logger.info("Local chat parse:", local);

  if (local.multipleAccounts) {
    return ctx.reply(
      `I found more than one account (${local.multipleAccounts.join(", ")}). To move money between accounts use 🔁 Transfer, or mention just one account.`,
      mainKeyboard
    );
  }

  let draft = null; // { type, amount, category, account|null, description }

  if (local.amount) {
    const guess = guessTransaction(local.description || text, incomeCategories, expenseCategories);
    let type = guess.type;
    let category = guess.category;

    const incomeCueMissed = local.incomeCue && type !== "income";
    if (incomeCueMissed) {
      type = "income";
      category = incomeCategories.find(c => /^other$/i.test(c)) || incomeCategories[0];
    }
    const unsure = incomeCueMissed || (type === "expense" && /^other$/i.test(category));

    draft = { type, amount: local.amount, category, account: local.account, description: local.description };

    if (unsure) {
      logger.info("Local category guess is unsure — asking AI to classify");
      const ai = await safeParseAI(text, lists);
      if (ai) {
        draft.type = ai.type;
        draft.category = ai.category;
        if (ai.description) draft.description = ai.description;
        if (!draft.account && ai.account) draft.account = ai.account;
      } else {
        logger.info("AI unavailable — keeping the local guess:", { type, category });
      }
    }
  } else if (looksLikeMoney(text)) {
    logger.info(local.ambiguousAmount ? "More than one amount in the message — asking AI" : "No local amount — asking AI");
    draft = await safeParseAI(text, lists);
  }

  if (!draft) {
    logger.warn("Could not understand message (local + AI):", text);
    return ctx.reply(CHAT_HELP, mainKeyboard);
  }

  if (!draft.account) {
    logger.info("No account in the message — asking which one");
    return ctx.scene.enter("QUICK_ACCOUNT_WIZARD", {
      type: draft.type,
      amount: draft.amount,
      category: draft.category,
      description: draft.description,
      accounts
    });
  }

  logger.info("Chat quick-add inserting:", draft);
  await insertTransaction({
    description: draft.description,
    category: draft.category,
    amount: draft.amount,
    account: draft.account,
    type: draft.type
  });
  return ctx.reply(addedMessage(draft), mainKeyboard);
}

// ---------- Bot ----------

function createBot(token) {
  // The webhook answers Telegram immediately and finishes the work in the background (see
  // api/telegram.js), so a message may take a while. Give up at 110s by default (max 140s),
  // which is inside the 150s function limit in vercel.json.
  const bot = new Telegraf(token, { handlerTimeout: Math.min(Number(process.env.HANDLER_TIMEOUT_MS) || 110000, 140000) });

  // Any error inside a handler: log it, and tell the user instead of staying silent.
  bot.catch(async (err, ctx) => {
    logger.error(`Handler error for update ${ctx?.update?.update_id}:`, err?.stack || err);
    try {
      await ctx.reply("⚠️ Something went wrong with that. Please try again, or use the buttons.", mainKeyboard);
    } catch (replyErr) {
      logger.error("Couldn't send the error message to the user:", replyErr.message);
    }
  });

  // Owner-only guard: the webhook URL is public, so ignore anyone but you.
  // If OWNER_USER_ID isn't set, everyone is allowed (set it!).
  const owner = process.env.OWNER_USER_ID;
  bot.use((ctx, next) => {
    if (!owner || String(ctx.from?.id) === owner) return next();
    logger.warn(`Blocked update from non-owner user ${ctx.from?.id}`);
  });

  const stage = new Scenes.Stage([
    incomeExpenseWizard,
    transferWizard,
    ocrConfirmWizard,
    autoTxAddWizard,
    autoTxPickWizard,
    budgetViewWizard,
    quickAccountWizard
  ]);

  // Sessions live in Redis (Upstash) so wizard state survives between serverless invocations.
  bot.use(session({ store: sessionStore }));
  bot.use(stage.middleware());

  bot.start(ctx => ctx.reply("Ready to track your finances.", mainKeyboard));

  bot.hears("➕ Income", ctx => ctx.scene.enter("INCOME_EXPENSE_WIZARD", { type: "income" }));
  bot.hears("➖ Expense", ctx => ctx.scene.enter("INCOME_EXPENSE_WIZARD", { type: "expense" }));
  bot.hears("🔁 Transfer", ctx => ctx.scene.enter("TRANSFER_WIZARD"));
  bot.hears(BUDGET_VIEW, ctx => ctx.scene.enter("BUDGET_VIEW_WIZARD"));

  bot.hears("💰 Available", async ctx => {
    const s = await getAvailableSummary();
    const sorted = [...s.accounts].sort((a, b) => b.value - a.value);
    const nameWidth = Math.max(...sorted.map(a => a.name.length), 4) + 2;

    const accountLines = sorted.map(a => {
      const emoji = a.value < 0 ? "🔴" : "🟢";
      return `${emoji} ${a.name.padEnd(nameWidth)}Rp ${formatIDR(a.value).padStart(12)}`;
    });

    const summaryBlock = [
      `Available      Rp ${formatIDR(s.available)}`,
      `Daily avail.   Rp ${formatIDR(s.dailyAvailable)}`,
      `Total          Rp ${formatIDR(s.total)}`
    ].join("\n");

    const message = `<b>💰 Financial Summary</b>\n<pre>${summaryBlock}\n\nACCOUNTS\n${accountLines.join("\n")}</pre>`;
    await ctx.replyWithHTML(message, mainKeyboard);
  });

  bot.hears(AUTO_MENU, async ctx => {
    const list = await listAutoTransactions();
    await ctx.replyWithHTML(
      renderAutoList(list),
      Markup.keyboard([[AUTO_ADD], [AUTO_DELETE, AUTO_TOGGLE], [AUTO_BACK]]).resize()
    );
  });
  bot.hears(AUTO_ADD, ctx => ctx.scene.enter("AUTO_TX_ADD_WIZARD"));
  bot.hears(AUTO_DELETE, ctx => ctx.scene.enter("AUTO_TX_PICK_WIZARD", { action: "delete" }));
  bot.hears(AUTO_TOGGLE, ctx => ctx.scene.enter("AUTO_TX_PICK_WIZARD", { action: "toggle" }));
  bot.hears(AUTO_BACK, ctx => ctx.reply("Main menu", mainKeyboard));

  // ---- Photo receipt: Gemini only (no local Tesseract on Vercel) ----
  bot.on("photo", async ctx => {
    logger.info(`Photo received from user ${ctx.from?.id}`);
    const ack = await sendAck(ctx, "🔍 Reading your receipt… (this can take up to a minute)");
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    const [accounts, expenseCategories] = await Promise.all([getAccounts(), getExpenseCategories()]);
    const buffer = await downloadBuffer(fileLink.href);

    let extracted = null;
    let matchedAccount = null;
    let category = null;

    const aiResult = await analyzeReceiptWithAI(buffer, "image/jpeg", { accounts, expenseCategories });
    await clearAck(ctx, ack);

    if (aiResult) {
      logger.info("Photo: using AI extraction", aiResult);
      extracted = { amount: aiResult.amount, description: aiResult.description || "" };
      matchedAccount = aiResult.account ? accounts.find(a => a.toLowerCase() === aiResult.account.toLowerCase()) : null;
      category = expenseCategories.find(c => c.toLowerCase() === (aiResult.category || "").toLowerCase()) || null;
    } else {
      logger.warn("Photo: AI unavailable/failed — no local OCR on Vercel, going to manual entry");
    }

    if (extracted?.amount && matchedAccount && category) {
      logger.info("Receipt: full confident match", { amount: extracted.amount, description: extracted.description, category, account: matchedAccount });
      await ctx.scene.enter("OCR_CONFIRM_WIZARD", {
        amount: extracted.amount,
        description: extracted.description || "",
        category,
        account: matchedAccount
      });
      const summary = [
        "📷 <b>Read from receipt:</b>",
        `Amount: Rp ${formatIDR(extracted.amount)}`,
        `Merchant: ${extracted.description || "-"}`,
        `Category: ${category}`,
        `Account: ${matchedAccount}`,
        "",
        "Is this correct?"
      ].join("\n");
      await ctx.replyWithHTML(summary, Markup.keyboard([[CONFIRM], [EDIT], [CANCEL]]).resize());
      return;
    }

    logger.info("Receipt: partial or no data, entering wizard with detected fields", extracted);
    if (extracted?.amount || extracted?.description || matchedAccount) {
      await ctx.reply("📷 Detected from receipt — confirm or override each field below.");
    } else {
      await ctx.reply("Couldn't read that photo (the AI may be busy) — enter the details manually.");
    }
    await ctx.scene.enter("INCOME_EXPENSE_WIZARD", {
      type: "expense",
      detectedAmount: extracted?.amount || null,
      detectedDescription: extracted?.description || null,
      detectedAccount: matchedAccount || null,
      detectedCategory: category || null
    });
  });

  // ---- PDF receipt: AI first, local pdf-parse text extraction as fallback ----
  bot.on("document", async ctx => {
    const doc = ctx.message.document;
    if (doc.mime_type !== "application/pdf") {
      return ctx.reply("I can only read PDF documents right now (send a photo for image receipts).", mainKeyboard);
    }

    logger.info(`PDF received from user ${ctx.from?.id}: ${doc.file_name}`);
    const ack = await sendAck(ctx, "🔍 Reading your PDF… (this can take up to a minute)");
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const [accounts, expenseCategories] = await Promise.all([getAccounts(), getExpenseCategories()]);
    const buffer = await downloadBuffer(fileLink.href);

    let extracted = null;
    let matchedAccount = null;
    let category = null;

    const aiResult = await analyzeReceiptWithAI(buffer, "application/pdf", { accounts, expenseCategories });
    await clearAck(ctx, ack);

    if (aiResult) {
      logger.info("PDF: using AI extraction", aiResult);
      extracted = { amount: aiResult.amount, description: aiResult.description || "" };
      matchedAccount = aiResult.account ? accounts.find(a => a.toLowerCase() === aiResult.account.toLowerCase()) : null;
      category = expenseCategories.find(c => c.toLowerCase() === (aiResult.category || "").toLowerCase()) || null;
    } else {
      logger.info("PDF: AI unavailable/failed, falling back to local text extraction");
      try {
        extracted = await extractReceiptDataFromPDF(buffer, accounts);
      } catch (err) {
        logger.error("Local PDF OCR failed:", err);
      }
      matchedAccount = extracted?.account ? accounts.find(a => a.toLowerCase() === extracted.account.toLowerCase()) : null;
      category = extracted?.description ? guessTransaction(extracted.description, [], expenseCategories).category : null;
    }

    if (extracted?.amount && matchedAccount && category) {
      logger.info("PDF: full confident match", { amount: extracted.amount, description: extracted.description, category, account: matchedAccount });
      await ctx.scene.enter("OCR_CONFIRM_WIZARD", {
        amount: extracted.amount,
        description: extracted.description || "",
        category,
        account: matchedAccount
      });
      const summary = [
        "📄 <b>Read from PDF:</b>",
        `Amount: Rp ${formatIDR(extracted.amount)}`,
        `Merchant: ${extracted.description || "-"}`,
        `Category: ${category}`,
        `Account: ${matchedAccount}`,
        "",
        "Is this correct?"
      ].join("\n");
      await ctx.replyWithHTML(summary, Markup.keyboard([[CONFIRM], [EDIT], [CANCEL]]).resize());
      return;
    }

    logger.info("PDF: partial or no data, entering wizard with detected fields", extracted);
    if (extracted?.amount || extracted?.description || matchedAccount) {
      await ctx.reply("📄 Detected from PDF — confirm or override each field below.");
    } else {
      await ctx.reply(
        extracted
          ? "Couldn't read data from that PDF — enter the details manually."
          : "Couldn't process that PDF — enter the details manually."
      );
    }
    await ctx.scene.enter("INCOME_EXPENSE_WIZARD", {
      type: "expense",
      detectedAmount: extracted?.amount || null,
      detectedDescription: extracted?.description || null,
      detectedAccount: matchedAccount || null,
      detectedCategory: category || null
    });
  });

  // ---- Free-form chat: understands any word order and informal money (7jt, 25rb, 2k) ----
  bot.on("text", ctx => handleChatText(ctx, ctx.message.text.trim()));

  return bot;
}

module.exports = createBot;
module.exports.handleChatText = handleChatText;
module.exports.renderAutoList = renderAutoList;
