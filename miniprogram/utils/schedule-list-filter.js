function uniqueLedgers(list) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    const id = item.ledgerId == null ? "" : String(item.ledgerId);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({
      id,
      name: item.ledgerName ? String(item.ledgerName) : "账本",
    });
  }
  return out;
}

function uniqueCategories(list, ledgerId) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    if (ledgerId && String(item.ledgerId || "") !== ledgerId) {
      continue;
    }
    const name = item.category == null ? "" : String(item.category);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 定时记账列表的本地筛选。
 * 账本、分类可单独使用，也可同时生效（交集）。
 * 某一维在当前范围内只有一个选项时不展示，并清掉该维条件。
 */
function buildScheduleFilters(list, selection) {
  const rows = Array.isArray(list) ? list : [];
  const picked = selection || {};
  const ledgerOptions = uniqueLedgers(rows);
  let filterLedgerId = picked.ledgerId == null ? "" : String(picked.ledgerId);
  if (filterLedgerId && !ledgerOptions.some((item) => item.id === filterLedgerId)) {
    filterLedgerId = "";
  }
  const showLedgerFilter = ledgerOptions.length > 1;
  if (!showLedgerFilter) {
    filterLedgerId = "";
  }

  const categoryOptions = uniqueCategories(rows, filterLedgerId);
  let filterCategory = picked.category == null ? "" : String(picked.category);
  const showCategoryFilter = categoryOptions.length > 1;
  if (!showCategoryFilter || (filterCategory && categoryOptions.indexOf(filterCategory) < 0)) {
    filterCategory = "";
  }

  const displayList = rows.filter((item) => {
    if (filterLedgerId && String((item && item.ledgerId) || "") !== filterLedgerId) {
      return false;
    }
    if (filterCategory && String((item && item.category) || "") !== filterCategory) {
      return false;
    }
    return true;
  });

  return {
    displayList,
    ledgerOptions,
    categoryOptions,
    showLedgerFilter,
    showCategoryFilter,
    filterLedgerId,
    filterCategory,
    filterActive: !!(filterLedgerId || filterCategory),
  };
}

module.exports = {
  buildScheduleFilters,
};
