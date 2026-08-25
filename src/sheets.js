const { google } = require("googleapis");
const dayjs = require("dayjs");

const logger = require("./logger");

let sheetsClient = null;

function getSheets() {
  if (!sheetsClient) {
    const authConfig = process.env.GOOGLE_CREDENTIALS_JSON
      ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] }
      : { keyFile: "credentials.json", scopes: ["https://www.googleapis.com/auth/spreadsheets"] };
    const auth = new google.auth.GoogleAuth(authConfig);
    sheetsClient = google.sheets({ version: "v4", auth });
  }
  return sheetsClient;
}

// gid of the "Transactions" tab - keep this in sync if you ever recreate the tab
const TRANSACTIONS_SHEET_ID = 949636491;

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
            range: { sheetId: TRANSACTIONS_SHEET_ID, dimension: "ROWS", startIndex: 1, endIndex: 2 },
            inheritFromBefore: false
          }
        },
        {
          repeatCell: {
            range: { sheetId: TRANSACTIONS_SHEET_ID, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 1 },
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

function mainCurrencyFormula(row) {
  return `=ROUND(D${row} * IF(VLOOKUP(E${row}, Preferences!$H$4:$J$22, 3, FALSE) = Preferences!$F$16, 1, IFNA(GOOGLEFINANCE("CURRENCY:" & VLOOKUP(E${row}, Preferences!$H$4:$J$22, 3, FALSE) & Preferences!$F$16), 1)), 2)`;
}

async function insertTransaction({ description, category, amount, account, type }) {
  const signed = type === "income" ? Math.abs(amount) : -Math.abs(amount);
  const date = dayjs().format("YYYY-MM-DD");
  await insertRow([date, description || "", category, signed, account, mainCurrencyFormula(2)]);
  return signed;
}

async function insertTransfer({ description, amount, fromAccount, toAccount, fee = 0 }) {
  const date = dayjs().format("YYYY-MM-DD");
  const desc = description || "";
  await insertRow([date, desc, "Transfer", -Math.abs(amount), fromAccount, mainCurrencyFormula(2)]);
  await insertRow([date, desc, "Transfer", Math.abs(amount), toAccount, mainCurrencyFormula(2)]);
  if (fee > 0) {
    await insertRow([date, `${desc} admin fee`.trim(), "Admin Fee", -Math.abs(fee), fromAccount, mainCurrencyFormula(2)]);
  }
}

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
    if (!v || String(v).trim().length === 0) break; // stop at first gap in the list
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
    valueRenderOption: "UNFORMATTED_VALUE"   // ← add this
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
      const col = row.findIndex(
        cell => String(cell || "").trim().toLowerCase() === "accounts"
      );
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

module.exports = {
  insertTransaction,
  insertTransfer,
  getExpenseCategories,
  getIncomeCategories,
  getAccounts,
  getAvailableSummary
};
