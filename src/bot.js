// bot.js
const { Telegraf, Scenes, session, Markup } = require("telegraf");

const {
  insertTransaction,
  insertTransfer,
  getExpenseCategories,
  getIncomeCategories,
  getAccounts,
  getAvailableSummary
} = require("./sheets");

const { extractReceiptData } = require("./ocr");
const { parseMessage } = require("./parser");
const { guessTransaction } = require("./categorizer");
const { parseWithAI } = require("./ai");
const logger = require("./logger");

const CANCEL = "❌ Cancel";
const NO_DESCRIPTION = "⏭ No description";
const NO_FEE = "🆓 No fee";
const CONFIRM = "✅ Confirm & Add";
const EDIT = "✏️ Edit details";

const mainKeyboard = Markup.keyboard([
  ["➕ Income", "➖ Expense"],
  ["🔁 Transfer"],
  ["💰 Available"]
]).resize();

function parseAmount(text) {
  const value = Number(String(text).replace(/[.,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
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

// ---------- Income / Expense wizard ----------

const enterAmountStep = async ctx => {
  await ctx.reply(`Specify an amount of ${ctx.scene.state.type}`, Markup.keyboard([[CANCEL]]).resize());
  return ctx.wizard.next();
};

const amountStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL || text.toLowerCase() === "cancel") {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const amount = parseAmount(text);
  if (amount === null) {
    return ctx.reply("Specify an amount, or tap ❌ Cancel");
  }
  ctx.scene.state.amount = amount;

  const categories =
    ctx.scene.state.type === "income"
      ? await getIncomeCategories()
      : await getExpenseCategories();
  ctx.scene.state.categories = categories;

  await ctx.reply(`Specify a category of ${ctx.scene.state.type}`, optionKeyboard(categories));
  return ctx.wizard.next();
};

const categoryStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  const match = (ctx.scene.state.categories || []).find(
    c => c.toLowerCase() === text.toLowerCase()
  );
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
  const match = (ctx.scene.state.accounts || []).find(
    a => a.toLowerCase() === cleaned.toLowerCase()
  );
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

  await ctx.reply(
    `👍 Successfully added ${signed}.0 to ${category} from ${account}!`,
    mainKeyboard
  );
  return ctx.scene.leave();
};

const incomeExpenseWizard = new Scenes.WizardScene(
  "INCOME_EXPENSE_WIZARD",
  enterAmountStep,   // 0
  amountStep,        // 1
  categoryStep,       // 2
  accountStep,        // 3
  descriptionStep      // 4
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
  if (amount === null) return ctx.reply("Specify an amount, or tap ❌ Cancel");
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
  enterTransferAmountStep, // 0
  transferAmountStep,      // 1
  transferFromStep,        // 2
  transferToStep,          // 3
  transferFeeStep,         // 4
  transferDescriptionStep   // 5
);

// ---------- OCR confirm wizard ----------

const ocrConfirmStep = async ctx => {
  const text = ctx.message?.text?.trim();
  if (!text) return;
  if (text === CANCEL) {
    await ctx.reply("Cancelled.", mainKeyboard);
    return ctx.scene.leave();
  }
  if (text === CONFIRM) {
    const { amount, description, category, account } = ctx.scene.state;
    logger.info("OCR confirmed as-is, inserting:", { amount, description, category, account });
    const signed = await insertTransaction({ description, category, amount, account, type: "expense" });
    await ctx.reply(`👍 Successfully added ${signed}.0 to ${category} from ${account}!`, mainKeyboard);
    return ctx.scene.leave();
  }
  if (text === EDIT) {
    const { amount, description, account } = ctx.scene.state;
    logger.info("User chose to edit OCR-extracted data");
    await ctx.scene.enter("INCOME_EXPENSE_WIZARD", {
      type: "expense",
      amount,
      detectedDescription: description,
      detectedAccount: account
    });
    const categories = await getExpenseCategories();
    ctx.scene.state.categories = categories;
    await ctx.reply("Specify a category of expense", optionKeyboard(categories));
    ctx.wizard.selectStep(2);
    return;
  }
  return ctx.reply("Please tap one of the buttons.");
};

const ocrConfirmWizard = new Scenes.WizardScene("OCR_CONFIRM_WIZARD", ocrConfirmStep);

// ---------- Bot ----------

function createBot(token) {
  const bot = new Telegraf(token);
  const stage = new Scenes.Stage([incomeExpenseWizard, transferWizard, ocrConfirmWizard]);

  bot.use(session());
  bot.use(stage.middleware());

  bot.start(ctx => ctx.reply("Ready to track your finances.", mainKeyboard));

  bot.hears("➕ Income", ctx => ctx.scene.enter("INCOME_EXPENSE_WIZARD", { type: "income" }));
  bot.hears("➖ Expense", ctx => ctx.scene.enter("INCOME_EXPENSE_WIZARD", { type: "expense" }));
  bot.hears("🔁 Transfer", ctx => ctx.scene.enter("TRANSFER_WIZARD"));

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

  // Photo -> OCR -> confirm-or-edit
  bot.on("photo", async ctx => {
    logger.info(`Photo received from user ${ctx.from?.id}`);
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    const [accounts, expenseCategories] = await Promise.all([getAccounts(), getExpenseCategories()]);

    let extracted = null;
    try {
      extracted = await extractReceiptData(fileLink.href, accounts);
    } catch (err) {
      logger.error("OCR failed:", err);
    }

    if (!extracted?.amount) {
      logger.warn("OCR: no usable amount extracted, falling back to manual entry");
      await ctx.scene.enter("INCOME_EXPENSE_WIZARD", { type: "expense" });
      await ctx.reply(
        extracted
          ? "Couldn't read an amount from that receipt — enter it manually."
          : "OCR isn't wired up yet — enter the amount manually.",
        Markup.keyboard([[CANCEL]]).resize()
      );
      return;
    }

    const matchedAccount = extracted.account
      ? accounts.find(a => a.toLowerCase() === extracted.account.toLowerCase())
      : null;
    const { category } = guessTransaction(extracted.description || "", [], expenseCategories);

    if (matchedAccount && category) {
      logger.info("OCR: full confident match", {
        amount: extracted.amount,
        description: extracted.description,
        category,
        account: matchedAccount
      });
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
    } else {
      logger.info("OCR: partial data, entering manual/edit flow", extracted);
      await ctx.scene.enter("INCOME_EXPENSE_WIZARD", {
        type: "expense",
        amount: extracted.amount,
        detectedDescription: extracted.description || null,
        detectedAccount: matchedAccount || null
      });
      ctx.scene.state.categories = expenseCategories;
      await ctx.reply(
        `📷 Detected amount: Rp ${formatIDR(extracted.amount)}` +
          (extracted.description ? `\nDetected merchant: ${extracted.description}` : "") +
          (matchedAccount ? `\nDetected account: ${matchedAccount}` : "")
      );
      await ctx.reply("Specify a category of expense", optionKeyboard(expenseCategories));
      ctx.wizard.selectStep(2);
    }
  });

  // Free-text quick add: strict "desc amount account" shorthand first (free),
  // natural-language sentences fall back to Gemini (only if GEMINI_API_KEY is set)
  bot.on("text", async ctx => {
    const text = ctx.message.text.trim();
    logger.info(`Text from user ${ctx.from?.id}:`, text);

    const [accounts, incomeCategories, expenseCategories] = await Promise.all([
      getAccounts(),
      getIncomeCategories(),
      getExpenseCategories()
    ]);

    const shorthand = parseMessage(text);
    logger.info("Shorthand parse result:", shorthand);

    if (shorthand) {
      const matchedAccount = accounts.find(a => a.toLowerCase() === shorthand.account.toLowerCase());
      if (!matchedAccount) {
        logger.warn(`Shorthand parsed but account "${shorthand.account}" not recognized`);
        return ctx.reply(
          `Didn't recognize account "${shorthand.account}". Your accounts: ${accounts.join(", ")}`,
          mainKeyboard
        );
      }
      const { type, category } = guessTransaction(shorthand.description, incomeCategories, expenseCategories);
      const signed = await insertTransaction({
        description: shorthand.description,
        category,
        amount: shorthand.amount,
        account: matchedAccount,
        type
      });
      logger.info("Shorthand transaction inserted:", { type, category, amount: shorthand.amount, account: matchedAccount });
      return ctx.reply(`👍 Successfully added ${signed}.0 to ${category} from ${matchedAccount}!`, mainKeyboard);
    }

    logger.info("Shorthand didn't match — trying AI parse");
    let aiResult = null;
    try {
      aiResult = await parseWithAI(text, { accounts, incomeCategories, expenseCategories });
    } catch (err) {
      logger.error("AI parse threw unexpectedly:", err);
    }

    if (!aiResult) {
      logger.warn("Could not parse message via shorthand or AI:", text);
      return ctx.reply(
        'Use the buttons below, or type: description amount account (e.g. "mcd 10000 cash")',
        mainKeyboard
      );
    }

    const signed = await insertTransaction({
      description: aiResult.description,
      category: aiResult.category,
      amount: aiResult.amount,
      account: aiResult.account,
      type: aiResult.type
    });
    logger.info("AI transaction inserted:", aiResult);
    await ctx.reply(`👍 Successfully added ${signed}.0 to ${aiResult.category} from ${aiResult.account}!`, mainKeyboard);
  });

  return bot;
}

module.exports = createBot;