const { google } = require("googleapis");
const logger = require("./logger");

function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

const RANGE = "AutoTransactions!A2:J1000";

async function listAutoTransactions() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: RANGE
  });
  const rows = res.data.values || [];
  return rows
    .map((r, i) => ({
      rowIndex: i + 2,
      id: r[0],
      type: r[1],
      description: r[2],
      amount: Number(r[3]),
      category: r[4],
      account: r[5],
      dayOfMonth: Number(r[6]),
      active: String(r[7]).toLowerCase() === "true",
      chatId: r[8],
      lastRun: r[9] || ""
    }))
    .filter(r => r.id);
}

async function addAutoTransaction({ type, description, amount, category, account, dayOfMonth, chatId }) {
  const sheets = getSheets();
  const id = Date.now().toString(36);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "AutoTransactions!A:J",
    valueInputOption: "USER_ENTERED",
    resource: { values: [[id, type, description, amount, category, account, dayOfMonth, "TRUE", chatId, ""]] }
  });
  logger.info("Auto-transaction added:", { id, type, description, amount, category, account, dayOfMonth });
  return id;
}

async function getSheetIdByTitle(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const tab = meta.data.sheets.find(s => s.properties.title === title);
  if (!tab) throw new Error(`Sheet tab "${title}" not found — did you create it?`);
  return tab.properties.sheetId;
}

async function deleteAutoTransaction(id) {
  const all = await listAutoTransactions();
  const target = all.find(a => a.id === id);
  if (!target) return false;
  const sheets = getSheets();
  const sheetId = await getSheetIdByTitle(sheets, "AutoTransactions");
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: target.rowIndex - 1, endIndex: target.rowIndex }
        }
      }]
    }
  });
  logger.info("Auto-transaction deleted:", id);
  return true;
}

async function setActive(id, active) {
  const all = await listAutoTransactions();
  const target = all.find(a => a.id === id);
  if (!target) return false;
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `AutoTransactions!H${target.rowIndex}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[active ? "TRUE" : "FALSE"]] }
  });
  return true;
}

async function markRun(id, dateStr) {
  const all = await listAutoTransactions();
  const target = all.find(a => a.id === id);
  if (!target) return false;
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `AutoTransactions!J${target.rowIndex}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[dateStr]] }
  });
  return true;
}

module.exports = { listAutoTransactions, addAutoTransaction, deleteAutoTransaction, setActive, markRun };