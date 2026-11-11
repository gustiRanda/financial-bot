const { google } = require("googleapis");
const logger = require("./logger");
const { now } = require("./time");

let sheetsClient = null;

function getSheets() {
  if (!sheetsClient) {
    const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
    // Deployed (Vercel): credentials come from the GOOGLE_CREDENTIALS_JSON env var.
    // Local dev: falls back to a credentials.json file in the project root.
    const authConfig = process.env.GOOGLE_CREDENTIALS_JSON
      ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON), scopes }
      : { keyFile: "credentials.json", scopes };
    const auth = new google.auth.GoogleAuth(authConfig);
    sheetsClient = google.sheets({ version: "v4", auth });
  }
  return sheetsClient;
}

// gid of the "Transactions" tab - keep this in sync if you ever recreate the tab
const TRANSACTIONS_SHEET_ID = 949636491;

// Live formula for column F ("In main currency"), so editing the amount later
// still recalculates correctly. New rows are always inserted at row 2.
function mainCurrencyFormula(row) {
  return `=ROUND(D${row} * IF(VLOOKUP(E${row}, Preferences!$H$4:$J$22, 3, FALSE) = Preferences!$F$16, 1, IFNA(GOOGLEFINANCE("CURRENCY:" & VLOOKUP(E${row}, Preferences!$H$4:$J$22, 3, FALSE) & Preferences!$F$16), 1)), 2)`;
}

async function insertRow(values) {
  logger.info("Writing row to Transactions:", values);
  const sheets = getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: TRANSACTIONS_SHEET_ID,
              dimension: "ROWS",
              startIndex: 1,
              endIndex: 2
            },
            inheritFromBefore: false
          }
        },
        {
          // inheritFromBefore:false drops column formatting, so force the date format every time
          repeatCell: {
            range: {
              sheetId: TRANSACTIONS_SHEET_ID,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 1
            },
            cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dddd, mmmm d, yyyy" } } },
            fields: "userEnteredFormat.numberFormat"
          }
        }
      ]
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Transactions!A2:F2",
    valueInputOption: "USER_ENTERED",
    resource: { values: [values] }
  });
}

async function insertTransaction({ description, category, amount, account, type }) {
  const signed = type === "income" ? Math.abs(amount) : -Math.abs(amount);
  // ISO date in Jakarta time: Sheets parses it as a real date regardless of locale,
  // and the server's own timezone (UTC on Vercel) can't shift it to "yesterday".
  const date = now().format("YYYY-MM-DD");
  await insertRow([date, description || "", category, signed, account, mainCurrencyFormula(2)]);
  return signed;
}

async function insertTransfer({ description, amount, fromAccount, toAccount, fee = 0 }) {
  const date = now().format("YYYY-MM-DD");
  const desc = description || "";
  await insertRow([date, desc, "Transfer", -Math.abs(amount), fromAccount, mainCurrencyFormula(2)]);
  await insertRow([date, desc, "Transfer", Math.abs(amount), toAccount, mainCurrencyFormula(2)]);
  if (fee > 0) {
    await insertRow([date, `${desc} admin fee`.trim(), "Admin Fee", -Math.abs(fee), fromAccount, mainCurrencyFormula(2)]);
  }
}

// Reads a single-column list and stops at the first blank cell, so unrelated
// content further down the same column (e.g. the "Dispute Handling" section) is ignored.
async function getColumn(range) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range
  });
  const rows = res.data.values || [];
  const out = [];
  for (const row of rows) {
    const v = row[0];
    if (!v || String(v).trim().length === 0) break;
    out.push(v);
  }
  return out;
}

async function getExpenseCategories() {
  const cats = await getColumn("Preferences!B4:B100");
  return cats.filter(c => c !== "Transfer");
}

async function getIncomeCategories() {
  const cats = await getColumn("Preferences!C4:C100");
  return cats.filter(c => c !== "Transfer");
}

async function getAccounts() {
  return getColumn("Preferences!H4:H100");
}

async function getAvailableSummary() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Main!A1:O30",
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = res.data.values || [];

  const findBelow = label => {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (String(row[c] || "").trim().toLowerCase() === label.toLowerCase()) {
          const next = rows[r + 1];
          return next ? next[c] : undefined;
        }
      }
    }
    return undefined;
  };

  const findAccounts = () => {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const col = row.findIndex(cell => String(cell || "").trim().toLowerCase() === "accounts");
      if (col !== -1) {
        const out = [];
        for (let rr = r + 1; rr < rows.length; rr++) {
          const rowData = rows[rr] || [];
          const name = rowData[col];
          if (!name) break;
          out.push({ name, value: Number(rowData[col + 1]) || 0 });
        }
        return out;
      }
    }
    return [];
  };

  return {
    available: Number(findBelow("Available")) || 0,
    total: Number(findBelow("Total")) || 0,
    dailyAvailable: Number(findBelow("Daily available")) || 0,
    accounts: findAccounts()
  };
}

// The Budget tab is driven by ONE date cell (B1). To view another month we write
// that month into B1, read the recalculated numbers, then put B1 back exactly as it was.
// targetDate: a dayjs object for any day inside the month you want.
async function getBudgetSummary(targetDate) {
  const sheets = getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // Raw serial number (not the display string) so restoring is locale-proof.
  const originalRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Budget!B1",
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const originalValue = originalRes.data.values?.[0]?.[0] ?? null;

  let rows;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Budget!B1",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[targetDate.format("YYYY-MM-DD")]] }
    });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Budget!A1:D45",
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    rows = res.data.values || [];
  } finally {
    // Always put B1 back, even if the read above failed.
    if (originalValue !== null) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: "Budget!B1",
          valueInputOption: "USER_ENTERED",
          resource: { values: [[originalValue]] }
        });
      } catch (err) {
        logger.error("Budget: FAILED to restore Budget!B1 to its original value:", originalValue, err);
      }
    }
  }

  const label = r => ((rows[r] || [])[0] || "").toString().trim();
  const plan = r => Number((rows[r] || [])[1]) || 0;
  const actual = r => Number((rows[r] || [])[2]) || 0;
  const diff = r => Number((rows[r] || [])[3]) || 0;

  const income = [];
  const expenses = [];
  let totalIncome = null;
  let totalExpenses = null;
  let profit = null;
  let section = null;

  for (let r = 1; r < rows.length; r++) {
    const name = label(r);
    if (!name) continue;
    if (/^income$/i.test(name)) { section = "income"; continue; }
    if (/^expenses$/i.test(name)) { section = "expenses"; continue; }
    if (/^total income$/i.test(name)) { totalIncome = { plan: plan(r), actual: actual(r), diff: diff(r) }; continue; }
    if (/^total expenses$/i.test(name)) { totalExpenses = { plan: plan(r), actual: actual(r), diff: diff(r) }; continue; }
    if (/^profit$/i.test(name)) { profit = diff(r) || actual(r); continue; }
    const entry = { name, plan: plan(r), actual: actual(r), diff: diff(r) };
    if (entry.plan === 0 && entry.actual === 0) continue;
    if (section === "income") income.push(entry);
    else if (section === "expenses") expenses.push(entry);
  }

  return {
    monthLabel: targetDate.format("MMMM YYYY"),
    income,
    expenses,
    totalIncome,
    totalExpenses,
    profit
  };
}

module.exports = {
  insertTransaction,
  insertTransfer,
  getExpenseCategories,
  getIncomeCategories,
  getAccounts,
  getAvailableSummary,
  getBudgetSummary
};
