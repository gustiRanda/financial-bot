const EXPENSE_RULES = [
  { match: /mcd|mcdonald|kfc|restoran|resto|warung|cafe|caffe|coffee|coffe|kopi|makan/i, hint: "food" },
  { match: /indomaret|alfamart|superindo|grocery|market/i, hint: "grocery" },
  { match: /kos|sewa|\brent\b/i, hint: "kos" },
  { match: /apotek|pharmacy|clinic|dokter|hospital/i, hint: "health" },
  { match: /grab|gojek|parkir|parking|bensin|fuel|toll/i, hint: "transport" }
];

const INCOME_RULES = [
  { match: /salary|gaji|payroll|thr|bonus/i, hint: "salary" },
  { match: /gift|hadiah/i, hint: "gift" },
  { match: /invest|dividend|saham/i, hint: "invest" },
  { match: /refund|reimburse|cashback/i, hint: "other" },
  { match: /overtime|lembur/i, hint: "overtime" }
];

function findCategory(categories, hint) {
  return categories.find(c => c.toLowerCase().includes(hint));
}

function guessTransaction(description, incomeCategories, expenseCategories) {
  const incomeRule = INCOME_RULES.find(r => r.match.test(description));
  if (incomeRule) {
    const cat = findCategory(incomeCategories, incomeRule.hint) || incomeCategories.find(c => c.toLowerCase() === "other") || incomeCategories[0];
    if (cat) return { type: "income", category: cat };
  }
  const expenseRule = EXPENSE_RULES.find(r => r.match.test(description));
  if (expenseRule) {
    const cat = findCategory(expenseCategories, expenseRule.hint) || expenseCategories.find(c => c.toLowerCase() === "other") || expenseCategories[0];
    return { type: "expense", category: cat };
  }
  // description IS a category name verbatim (e.g. someone types "salary 5000000 bri")
  const directIncome = incomeCategories.find(c => c.toLowerCase() === description.toLowerCase());
  if (directIncome) return { type: "income", category: directIncome };
  const directExpense = expenseCategories.find(c => c.toLowerCase() === description.toLowerCase());
  if (directExpense) return { type: "expense", category: directExpense };

  return { type: "expense", category: expenseCategories.find(c => c.toLowerCase() === "other") || expenseCategories[0] || "Other" };
}

module.exports = { guessTransaction };