function safeEnterQuery(syncFn) {
  try {
    if (typeof syncFn !== "function") {
      return {};
    }
    const o = syncFn();
    return (o && o.query) || {};
  } catch (e) {
    return {};
  }
}

const INSIGHT_POLICY = {
  // 最小样本笔数，低于该值时给保守文案
  minSampleCount: 3,
  // 环比变化低于该阈值（%）时，判定为波动较小
  minorChangeThresholdPct: 10,
  // 防止小基数出现夸张百分比
  maxRatePercent: 999,
  // 默认占位与文案
  fallbackTopLabel: "其他",
  noDataText: "AI洞察：当前时段暂无流水，记一笔后统计会更准确。",
  smallSampleStableText: "AI洞察：{period}样本量较少（{count} 笔），当前收支接近平衡，建议继续积累数据后判断趋势。",
  compareHintByRange: {
    week: "较上周",
    month: "较上月",
    year: "较去年",
    default: "较上期",
  },
};
const analyzeScope = require("../../utils/analyze-scope");
const LAST_ANALYZE_FILTERS_STORAGE_KEY = "lastAnalyzeFilters";

function readLastAnalyzeFilters() {
  try {
    const raw = wx.getStorageSync(LAST_ANALYZE_FILTERS_STORAGE_KEY);
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const range = raw.range;
    if (range !== "week" && range !== "month" && range !== "year") {
      return null;
    }
    const selectedYear = toInt(raw.selectedYear);
    const selectedMonth = toInt(raw.selectedMonth);
    const weekAnchorDate = String(raw.weekAnchorDate || "").trim();
    const trendKind = raw.trendKind === "income" ? "income" : "expense";
    const out = { range, trendKind };
    if (selectedYear) {
      out.selectedYear = selectedYear;
      out.yearPickerValue = `${selectedYear}`;
    }
    if (selectedMonth) {
      out.selectedMonth = selectedMonth;
    }
    if (selectedYear && selectedMonth) {
      out.monthPickerValue = `${selectedYear}-${pad2(selectedMonth)}`;
    }
    if (weekAnchorDate && parseYmd(weekAnchorDate)) {
      out.weekAnchorDate = weekAnchorDate;
    }
    return out;
  } catch (e) {
    return null;
  }
}

function writeLastAnalyzeFilters(data) {
  const range = data && data.range;
  if (range !== "week" && range !== "month" && range !== "year") {
    return;
  }
  const selectedYear = toInt(data.selectedYear);
  const selectedMonth = toInt(data.selectedMonth);
  const weekAnchorDate = String((data && data.weekAnchorDate) || "").trim();
  try {
    wx.setStorageSync(LAST_ANALYZE_FILTERS_STORAGE_KEY, {
      range,
      selectedYear: selectedYear || 0,
      selectedMonth: selectedMonth || 0,
      weekAnchorDate: weekAnchorDate && parseYmd(weekAnchorDate) ? weekAnchorDate : "",
      trendKind: data.trendKind === "income" ? "income" : "expense",
    });
  } catch (e) {
    // ignore
  }
}

function pickLedgerId(...queryObjs) {
  for (let i = 0; i < queryObjs.length; i += 1) {
    const q = queryObjs[i];
    if (!q || typeof q !== "object") {
      continue;
    }
    const raw = q.id ?? q.ledgerId ?? q.lid;
    if (raw == null) {
      continue;
    }
    let id = String(raw).trim();
    if (!id) {
      continue;
    }
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      // ignore
    }
    id = id.trim();
    if (id) {
      return id;
    }
  }
  return "";
}

function yuanWithCurrency(signedYuan) {
  const s = String(signedYuan == null ? "0.00" : signedYuan).trim();
  if (s.startsWith("+")) {
    return `+¥${s.slice(1)}`;
  }
  if (s.startsWith("-")) {
    return `-¥${s.slice(1)}`;
  }
  return `¥${s}`;
}

function normalizeAvatarUrl(raw) {
  let url = String(raw == null ? "" : raw).trim().slice(0, 500);
  if (!url) {
    return "";
  }
  if (url.startsWith("http://")) {
    url = `https://${url.slice("http://".length)}`;
  }
  return url;
}

function isCloudAvatarUrl(url) {
  const s = String(url || "");
  return !!s && s.startsWith("cloud://");
}

function parseSignedYuan(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function safePercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

function safeRatePercent(delta, base) {
  const b = Math.abs(Number(base) || 0);
  if (!b) {
    return 0;
  }
  const r = (Math.abs(Number(delta) || 0) * 100) / b;
  // 避免小基数导致的夸张比例
  return Math.min(INSIGHT_POLICY.maxRatePercent, Math.round(r));
}

function getCompareHintByRange(range) {
  if (range === "week" || range === "month" || range === "year") {
    return INSIGHT_POLICY.compareHintByRange[range];
  }
  return INSIGHT_POLICY.compareHintByRange.default;
}

function buildInsightText({
  txCount,
  range,
  rangeLabel,
  netYuan,
  totalExpenseYuan,
  totalIncomeYuan,
  groups,
  groupBy,
  compareHint,
  compareRangeLabel,
  compareTxCount,
  compareTotalExpenseYuan,
  compareNetYuan,
}) {
  const {
    minSampleCount,
    minorChangeThresholdPct,
    fallbackTopLabel,
    noDataText,
    smallSampleStableText,
  } = INSIGHT_POLICY;
  if (!txCount) {
    return noDataText;
  }
  const net = parseSignedYuan(netYuan);
  const expense = Math.max(0, parseSignedYuan(totalExpenseYuan));
  const income = Math.max(0, parseSignedYuan(totalIncomeYuan));
  const compareExpense = Math.max(0, parseSignedYuan(compareTotalExpenseYuan));
  const compareNet = parseSignedYuan(compareNetYuan);
  const top = Array.isArray(groups) && groups.length ? groups[0] : null;
  const topLabel = top && top.label ? top.label : "";
  const topPercent = top ? safePercent(top.percent) : 0;
  const dimText = groupBy === "person" ? "记账人" : "分类";
  const periodText = rangeLabel || "本时段";
  const compareText = compareHint || getCompareHintByRange(range);
  const compareSpan = compareRangeLabel || "上一周期";
  const hasCompare = Number(compareTxCount) > 0;
  const enoughCurrentSample = Number(txCount) >= minSampleCount;
  const enoughCompareSample = Number(compareTxCount) >= minSampleCount;
  const smallSample = !enoughCurrentSample || (hasCompare && !enoughCompareSample);
  const topLabelText = topLabel || fallbackTopLabel;

  if (smallSample) {
    if (net > 0) {
      return `AI洞察：${periodText}当前为小样本（${txCount} 笔），结余 ${yuanWithCurrency(
        net.toFixed(2)
      )}，建议继续观察${dimText}「${topLabelText}」的后续变化。`;
    }
    if (net < 0) {
      return `AI洞察：${periodText}当前为小样本（${txCount} 笔），净支出 ${yuanWithCurrency(
        net.toFixed(2)
      )}，可先关注${dimText}「${topLabelText}」是否持续偏高。`;
    }
    return smallSampleStableText
      .replace("{period}", periodText)
      .replace("{count}", String(txCount));
  }

  if (hasCompare && compareExpense > 0) {
    const delta = expense - compareExpense;
    const deltaRate = safeRatePercent(delta, compareExpense);
    if (deltaRate < minorChangeThresholdPct) {
      return `AI洞察：${periodText}${compareText}支出波动较小（约 ${deltaRate}%），整体较稳定；${dimText}「${topLabelText}」占比 ${topPercent}%。`;
    }
    if (delta > 0) {
      return `AI洞察：${periodText}${compareText}支出上升约 ${deltaRate}%（对比 ${compareSpan}），${dimText}「${
        topLabelText
      }」占比 ${topPercent}%，建议优先关注。`;
    }
    if (delta < 0) {
      return `AI洞察：${periodText}${compareText}支出下降约 ${deltaRate}%（对比 ${compareSpan}），结构向好，${dimText}「${
        topLabelText
      }」仍是主要贡献项。`;
    }
  }

  if (hasCompare && compareNet !== 0 && net !== compareNet) {
    const deltaNet = net - compareNet;
    const up = deltaNet > 0;
    const rate = safeRatePercent(deltaNet, compareNet);
    if (rate < minorChangeThresholdPct) {
      return `AI洞察：${periodText}${compareText}净额变化不大（约 ${rate}%），结构保持稳定，${dimText}「${topLabelText}」占比 ${topPercent}%。`;
    }
    return `AI洞察：${periodText}${compareText}净额${up ? "改善" : "回落"}约 ${rate}%（对比 ${compareSpan}），${dimText}「${
      topLabelText
    }」占比 ${topPercent}%。`;
  }

  if (income <= 0 && expense > 0) {
    return `AI洞察：${periodText}全部为支出，${dimText}「${topLabelText}」占比约 ${topPercent}%，建议重点关注。`;
  }
  if (net > 0) {
    return `AI洞察：${periodText}结余 ${yuanWithCurrency(net.toFixed(2))}，收入覆盖支出，${dimText}「${topLabelText}」占比 ${topPercent}%。`;
  }
  if (net < 0) {
    const absNet = Math.abs(net);
    const over = income > 0 ? Math.round((absNet / income) * 100) : 100;
    return `AI洞察：${periodText}净支出偏高（约超收入 ${over}%），优先优化${dimText}「${topLabelText}」相关开销。`;
  }
  return `AI洞察：${periodText}收支基本平衡，${dimText}「${topLabelText}」占比 ${topPercent}%，结构较稳定。`;
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function nowYearMonth() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  };
}

function toInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.floor(n);
}

function formatYmd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYmd(raw) {
  if (!raw) {
    return null;
  }
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || da < 1 || da > 31) {
    return null;
  }
  const d = new Date(y, mo - 1, da);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d;
}

function addDaysYmd(ymd, days) {
  const d = parseYmd(ymd) || new Date();
  d.setDate(d.getDate() + days);
  return formatYmd(d);
}

function startOfWeekMondayFromDate(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = t.getDay();
  const diff = (day + 6) % 7;
  t.setDate(t.getDate() - diff);
  return t;
}

function weekKeyFromYmd(ymd) {
  const d = parseYmd(ymd);
  if (!d) {
    return "";
  }
  return formatYmd(startOfWeekMondayFromDate(d));
}

function monthQuickState(todayYmd, selectedYear, selectedMonth) {
  const d = parseYmd(todayYmd) || new Date();
  const currY = d.getFullYear();
  const currM = d.getMonth() + 1;
  if (selectedYear === currY && selectedMonth === currM) {
    return "current";
  }
  const prev = new Date(currY, currM - 2, 1);
  if (selectedYear === prev.getFullYear() && selectedMonth === prev.getMonth() + 1) {
    return "prev";
  }
  return "custom";
}

function weekQuickState(todayYmd, weekAnchorDate) {
  const base = todayYmd || formatYmd(new Date());
  const currKey = weekKeyFromYmd(base);
  const prevKey = weekKeyFromYmd(addDaysYmd(base, -7));
  const selectedKey = weekKeyFromYmd(weekAnchorDate);
  if (selectedKey && selectedKey === currKey) {
    return "current";
  }
  if (selectedKey && selectedKey === prevKey) {
    return "prev";
  }
  return "custom";
}

function mapGroupsForList(raw) {
  return (raw || []).map((g) => {
    const c = Number(g.amountCents) || 0;
    let amtTone = "amt-zero";
    if (c < 0) {
      amtTone = "amt-neg";
    } else if (c > 0) {
      amtTone = "amt-expense";
    }
    return {
      ...g,
      barWidth: Math.min(100, Math.max(2, g.percent || 0)),
      amtTone,
      rowAmtDisplay: yuanWithCurrency(g.amountYuan),
    };
  });
}

function buildBudgetVsFields(r, range) {
  const mb =
    r.monthlyBudgetCents != null && Number(r.monthlyBudgetCents) > 0
      ? Math.floor(Number(r.monthlyBudgetCents))
      : 0;
  const showBudgetVs = range === "month" && mb > 0;
  if (!showBudgetVs) {
    return {
      showBudgetVs: false,
      budgetYuan: "",
      budgetBarWidth: 0,
      budgetUsedPercentDisplay: 0,
      budgetFootText: "",
      budgetPctTone: "budget-pct-ok",
      budgetFillClass: "",
    };
  }
  const usedPct =
    r.budgetUsedPercent != null && Number.isFinite(Number(r.budgetUsedPercent))
      ? Math.floor(Number(r.budgetUsedPercent))
      : 0;
  const barW =
    r.budgetBarWidth != null && Number.isFinite(Number(r.budgetBarWidth))
      ? Math.min(100, Math.max(0, Number(r.budgetBarWidth)))
      : 0;
  const remCents =
    r.budgetRemainingCents != null && Number.isFinite(Number(r.budgetRemainingCents))
      ? Math.floor(Number(r.budgetRemainingCents))
      : 0;
  const remYuan = (remCents / 100).toFixed(2);
  const state = r.budgetState || "ok";
  let budgetPctTone = "budget-pct-ok";
  let budgetFillClass = "";
  let budgetFootText = `已用占预算 ${usedPct}% · 剩余 ¥${remYuan}`;
  if (state === "over") {
    budgetPctTone = "budget-pct-over";
    budgetFillClass = "budget-fill-over";
    const overCents = -Math.min(0, remCents);
    budgetFootText = `已用占预算 ${usedPct}% · 超出 ¥${(overCents / 100).toFixed(2)}`;
  } else if (state === "warn") {
    budgetPctTone = "budget-pct-warn";
    budgetFillClass = "budget-fill-warn";
    budgetFootText = `已用占预算 ${usedPct}% · 剩余 ¥${remYuan} · 接近上限`;
  }
  return {
    showBudgetVs: true,
    budgetYuan: (mb / 100).toFixed(2),
    budgetBarWidth: barW,
    budgetUsedPercentDisplay: usedPct,
    budgetFootText,
    budgetPctTone,
    budgetFillClass,
  };
}

function readLedgerCreatedMs(ledger) {
  const n = Number(ledger && ledger.createdAtMs);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return Date.now();
}

function monthStartFromDate(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function weekEndSundayFromMonday(mon) {
  const e = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
  e.setDate(e.getDate() + 6);
  return e;
}

function formatMdSlash(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function buildMonthPeriodChips(ledgerCreatedMs, now = new Date()) {
  const end = monthStartFromDate(now);
  const creation = new Date(ledgerCreatedMs);
  let start = monthStartFromDate(creation);
  if (start.getTime() > end.getTime()) {
    start = new Date(end);
  }
  const currY = now.getFullYear();
  const currM = now.getMonth() + 1;
  const prevDate = new Date(currY, currM - 2, 1);
  const prevY = prevDate.getFullYear();
  const prevM = prevDate.getMonth() + 1;
  const firstY = start.getFullYear();
  const firstM = start.getMonth() + 1;
  const chips = [];
  const walk = new Date(start);
  while (walk.getTime() <= end.getTime()) {
    const y = walk.getFullYear();
    const m = walk.getMonth() + 1;
    let label;
    if (y === currY && m === currM) {
      label = "本月";
    } else if (y === prevY && m === prevM) {
      label = "上月";
    } else if (y === firstY && m === firstM) {
      label = `${y}年${m}月`;
    } else if (y === currY) {
      label = `${m}月`;
    } else {
      label = `${y}年${m}月`;
    }
    chips.push({
      key: `m-${y}-${m}`,
      kind: "month",
      label,
      year: y,
      month: m,
      active: false,
    });
    walk.setMonth(walk.getMonth() + 1);
  }
  return chips;
}

function buildYearPeriodChips(ledgerCreatedMs, now = new Date()) {
  const yStart = new Date(ledgerCreatedMs).getFullYear();
  const yEnd = now.getFullYear();
  const chips = [];
  if (yStart > yEnd) {
    chips.push({
      key: `y-${yEnd}`,
      kind: "year",
      label: "今年",
      year: yEnd,
      active: false,
    });
    return chips;
  }
  for (let y = yStart; y <= yEnd; y += 1) {
    let label;
    if (y === yEnd) {
      label = "今年";
    } else if (y === yStart) {
      label = `${y}年`;
    } else if (y === yEnd - 1) {
      label = "去年";
    } else {
      label = `${y}年`;
    }
    chips.push({
      key: `y-${y}`,
      kind: "year",
      label,
      year: y,
      active: false,
    });
  }
  return chips;
}

function buildWeekPeriodChips(ledgerCreatedMs, now = new Date()) {
  const currMon = startOfWeekMondayFromDate(now);
  const creation = new Date(ledgerCreatedMs);
  const firstMon = startOfWeekMondayFromDate(creation);
  const endMon = new Date(currMon.getFullYear(), currMon.getMonth(), currMon.getDate());
  const currKey = formatYmd(currMon);
  const prevMon = parseYmd(addDaysYmd(currKey, -7));
  const prevKey = prevMon ? formatYmd(prevMon) : "";
  const firstKey = formatYmd(firstMon);
  const chips = [];
  if (firstMon.getTime() > endMon.getTime()) {
    chips.push({
      key: `w-${currKey}`,
      kind: "week",
      label: "本周",
      weekMondayYmd: currKey,
      active: false,
    });
    return chips;
  }
  const walk = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate());
  while (walk.getTime() <= endMon.getTime()) {
    const key = formatYmd(walk);
    const wEnd = weekEndSundayFromMonday(walk);
    let label;
    if (key === currKey) {
      label = "本周";
    } else if (prevKey && key === prevKey) {
      label = "上周";
    } else if (key === firstKey) {
      const sy = walk.getFullYear();
      const ey = wEnd.getFullYear();
      if (sy === ey) {
        label = `${sy}/${walk.getMonth() + 1}/${walk.getDate()}-${wEnd.getMonth() + 1}/${wEnd.getDate()}`;
      } else {
        label = `${sy}/${walk.getMonth() + 1}/${walk.getDate()}-${ey}/${wEnd.getMonth() + 1}/${wEnd.getDate()}`;
      }
    } else {
      label = `${formatMdSlash(walk)}-${formatMdSlash(wEnd)}`;
    }
    chips.push({
      key: `w-${key}`,
      kind: "week",
      label,
      weekMondayYmd: key,
      active: false,
    });
    walk.setDate(walk.getDate() + 7);
  }
  return chips;
}

function markPeriodChipsActive(chips, selectedYear, selectedMonth, weekAnchorDate) {
  const wk = weekKeyFromYmd(weekAnchorDate);
  return (chips || []).map((c) => {
    let active = false;
    if (c.kind === "month") {
      active = c.year === selectedYear && c.month === selectedMonth;
    } else if (c.kind === "year") {
      active = c.year === selectedYear;
    } else if (c.kind === "week") {
      active = c.weekMondayYmd === wk;
    }
    return { ...c, active };
  });
}

function pickDefaultTimeSelection(range) {
  const now = new Date();
  if (range === "month") {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    return {
      selectedYear: y,
      selectedMonth: m,
      monthPickerValue: `${y}-${pad2(m)}`,
    };
  }
  if (range === "year") {
    const y = now.getFullYear();
    return {
      selectedYear: y,
      yearPickerValue: `${y}`,
    };
  }
  return { weekAnchorDate: formatYmd(now) };
}

function applySelectionFromLastChip(chips, range) {
  if (!chips.length) {
    return pickDefaultTimeSelection(range);
  }
  const last = chips[chips.length - 1];
  if (last.kind === "month") {
    return {
      selectedYear: last.year,
      selectedMonth: last.month,
      monthPickerValue: `${last.year}-${pad2(last.month)}`,
    };
  }
  if (last.kind === "year") {
    return {
      selectedYear: last.year,
      yearPickerValue: `${last.year}`,
    };
  }
  return { weekAnchorDate: last.weekMondayYmd };
}

function ensureSelectionInChips(chips, range, sel) {
  const { selectedYear, selectedMonth, weekAnchorDate } = sel;
  const wk = weekKeyFromYmd(weekAnchorDate);
  let ok = false;
  for (let i = 0; i < chips.length; i += 1) {
    const c = chips[i];
    if (c.kind === "month" && c.year === selectedYear && c.month === selectedMonth) {
      ok = true;
      break;
    }
    if (c.kind === "year" && c.year === selectedYear) {
      ok = true;
      break;
    }
    if (c.kind === "week" && c.weekMondayYmd === wk) {
      ok = true;
      break;
    }
  }
  if (ok) {
    return sel;
  }
  return { ...sel, ...applySelectionFromLastChip(chips, range) };
}

const CHART_PALETTE = [
  "#0066ff",
  "#36cfc9",
  "#ffc53d",
  "#ff7a45",
  "#9254de",
  "#5cdbd3",
  "#f759ab",
  "#73d13d",
];

/** 折线图单序列金额（元）；兼容旧接口仅返回 net 时点 */
function trendPointAmt(p, kind) {
  if (p && p.income != null && p.expense != null) {
    const inc = Number(p.income) || 0;
    const exp = Number(p.expense) || 0;
    return kind === "income" ? Math.max(0, inc) : Math.max(0, exp);
  }
  const net = Number(p && p.net) || 0;
  if (kind === "income") {
    return net > 0 ? net : 0;
  }
  return net < 0 ? -net : 0;
}

function buildChartPieRows(groups) {
  return (groups || [])
    .filter((g) => Math.abs(Number(g.amountCents) || 0) > 0)
    .slice(0, 8)
    .map((g) => {
      const t = String((g && g.label) || "");
      return {
        type: t.length > 10 ? `${t.slice(0, 10)}…` : t,
        k: "1",
        value: Math.abs(Number(g.amountCents) || 0) / 100,
      };
    });
}

/** 旧云函数无 pieGroups* 时，由分组近似拆流；支出含「负净额」与「正分仅支出排行」两种数据形态 */
function splitSignedGroupsForPieFallback(groupsSigned, kind) {
  return (groupsSigned || [])
    .map((g) => {
      const c = Number(g.amountCents) || 0;
      let mag;
      if (kind === "income") {
        mag = c > 0 ? c : 0;
      } else {
        mag = c < 0 ? -c : c > 0 ? c : 0;
      }
      return {
        key: g.key,
        label: g.label,
        amountCents: mag,
        count: g.count,
      };
    })
    .filter((g) => (Number(g.amountCents) || 0) > 0);
}

Page({
  data: {
    loading: true,
    ledgersLoading: false,
    listLoading: false,
    /** all | single | multi | group */
    scopeMode: "all",
    selectedLedgerIds: [],
    activeGroupId: "",
    scopeLabel: "全部账本",
    scopeSheetOpen: false,
    scopeDraftIds: [],
    scopeLedgerRows: [],
    statGroups: [],
    ledgers: [],
    range: "month",
    selectedYear: 0,
    selectedMonth: 0,
    weekAnchorDate: "",
    todayYmd: "",
    monthPickerValue: "",
    yearPickerValue: "",
    periodChips: [],
    periodChipCount: 0,
    periodScrollIntoView: "",
    weekQuick: "current",
    monthQuick: "current",
    rangeLabel: "",
    netAmountDisplay: "¥0.00",
    netTone: "net-zero",
    totalExpenseYuan: "0.00",
    totalIncomeYuan: "0.00",
    txCount: 0,
    groupsCategory: [],
    groupsPerson: [],
    insightText: INSIGHT_POLICY.noDataText,
    showBudgetVs: false,
    budgetYuan: "",
    budgetBarWidth: 0,
    budgetUsedPercentDisplay: 0,
    budgetFootText: "",
    budgetPctTone: "budget-pct-ok",
    budgetFillClass: "",
    chartOpts: { lazyLoad: true },
    showLineChart: false,
    showPieChart: false,
    trendPoints: [],
    /** 折线图：expense | income */
    trendKind: "expense",
    chartPieRowsExpense: [],
    chartPieRowsIncome: [],
    pieChartCurrentEmpty: false,
    txDataTruncated: false,
    txDataTruncatedHint: "",
  },

  onLoad(options) {
    const now = nowYearMonth();
    const todayYmd = formatYmd(new Date());
    const patch = {
      selectedYear: now.year,
      selectedMonth: now.month,
      weekAnchorDate: todayYmd,
      todayYmd,
      monthPickerValue: `${now.year}-${pad2(now.month)}`,
      yearPickerValue: `${now.year}`,
    };
    const savedFilters = readLastAnalyzeFilters();
    if (savedFilters) {
      Object.assign(patch, savedFilters);
    }
    this.setData(patch);
    const launchQ = safeEnterQuery(wx.getLaunchOptionsSync);
    const ledgerId = pickLedgerId(options, launchQ);
    this._preferredLedgerId = ledgerId || "";
    this._savedScopeState = null;
  },

  onShow() {
    this.setTabBarState({ selected: 1, hidden: false });
    const app = getApp();
    const preferredFromNav = String(
      (app.globalData && app.globalData.analyzePreferredLedgerId) || ""
    ).trim();
    if (preferredFromNav) {
      app.globalData.analyzePreferredLedgerId = "";
      this._preferredLedgerId = preferredFromNav;
      this._rebuildWithCurrentMonth = true;
    }
    if (!this.ensureEnv()) {
      return;
    }
    this.refreshLedgersAndLoad();
  },

  setTabBarState(patch) {
    if (typeof this.getTabBar !== "function") {
      return;
    }
    const tabBar = this.getTabBar();
    if (!tabBar || typeof tabBar.setData !== "function") {
      return;
    }
    tabBar.setData(patch || {});
  },

  ensureEnv() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env。",
      });
      this.setData({ loading: false, ledgersLoading: false, listLoading: false });
      return false;
    }
    return true;
  },

  refreshLedgersAndLoad() {
    if (this.data.ledgersLoading) {
      return;
    }
    this.setData({ ledgersLoading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgers" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          this._rebuildWithCurrentMonth = false;
          wx.showToast({ title: r.errMsg || "加载账本失败", icon: "none" });
          this.setData({ loading: false, listLoading: false });
          return;
        }
        const ledgers = r.list || [];
        if (!ledgers.length) {
          this._rebuildWithCurrentMonth = false;
          this.destroyF2Charts();
          this.setData({
            loading: false,
            listLoading: false,
            ledgers,
            scopeMode: "all",
            selectedLedgerIds: [],
            activeGroupId: "",
            scopeLabel: "",
            statGroups: [],
            scopeLedgerRows: [],
            groupsCategory: [],
            groupsPerson: [],
            showLineChart: false,
            showPieChart: false,
            trendPoints: [],
            chartPieRowsExpense: [],
            chartPieRowsIncome: [],
            pieChartCurrentEmpty: false,
            periodChips: [],
            periodChipCount: 0,
            ...buildBudgetVsFields({}, "week"),
          });
          return;
        }
        const preferredId = String(this._preferredLedgerId || "").trim();
        const statGroups = analyzeScope.enrichStatGroupsForDisplay(
          analyzeScope.readAnalyzeStatGroups(),
          ledgers
        );
        const resolved = analyzeScope.resolveScopeFromLedgers(ledgers, {
          preferredId,
          statGroups,
        });
        if (resolved.pruned || resolved.prunedFromGroup) {
          wx.showToast({ title: "部分账本已不可用，已自动更新范围", icon: "none" });
        }
        const scopeState = {
          mode: resolved.mode,
          ledgerIds: resolved.ledgerIds,
          groupId: resolved.groupId || "",
        };
        analyzeScope.writeLastAnalyzeScope(scopeState);
        this._savedScopeState = scopeState;
        this._preferredLedgerId = "";
        const scopeLedgerRows = analyzeScope.buildLedgerPickerRows(
          ledgers,
          resolved.ledgerIds
        );
        this.setData(
          {
            ledgers,
            statGroups,
            scopeMode: resolved.mode,
            selectedLedgerIds: resolved.ledgerIds,
            activeGroupId: resolved.groupId || "",
            scopeLabel: resolved.scopeLabel,
            scopeLedgerRows,
            scopeDraftIds: resolved.ledgerIds.length
              ? resolved.ledgerIds.slice()
              : ledgers.map((x) => String(x._id || "")).filter(Boolean),
          },
          () => {
            if (this._rebuildWithCurrentMonth) {
              this._rebuildWithCurrentMonth = false;
              const monthSel = pickDefaultTimeSelection("month");
              const todayYmd = formatYmd(new Date());
              this.setData(
                {
                  range: "month",
                  selectedYear: monthSel.selectedYear,
                  selectedMonth: monthSel.selectedMonth,
                  monthPickerValue: monthSel.monthPickerValue,
                  todayYmd,
                  weekAnchorDate: todayYmd,
                },
                () => this.rebuildPeriodChips({ defaultToCurrent: true })
              );
              return;
            }
            this.rebuildPeriodChips();
          }
        );
      })
      .catch(() => {
        this._rebuildWithCurrentMonth = false;
        wx.showToast({
          title: "请上传并部署云函数 ledgerFunctions",
          icon: "none",
        });
        this.setData({ loading: false, listLoading: false });
      })
      .finally(() => {
        this.setData({ ledgersLoading: false });
      });
  },

  setCustomTabBarHidden(hidden) {
    this.setTabBarState({ hidden: !!hidden });
  },

  getScopeStateFromData() {
    return {
      mode: this.data.scopeMode,
      ledgerIds: (this.data.selectedLedgerIds || []).slice(),
      groupId: String(this.data.activeGroupId || "").trim(),
    };
  },

  applyScopeState(scopeState, options) {
    const opts = options || {};
    const ledgers = this.data.ledgers || [];
    const mode = scopeState.mode;
    let ledgerIds = analyzeScope.pruneLedgerIds(ledgers, scopeState.ledgerIds || []);
    if (mode !== "all" && !ledgerIds.length) {
      wx.showToast({ title: "请至少选择一个账本", icon: "none" });
      return false;
    }
    let nextMode = "all";
    if (mode === "all") {
      nextMode = "all";
    } else if (mode === "group") {
      nextMode = "group";
    } else if (ledgerIds.length === 1) {
      nextMode = "single";
    } else {
      nextMode = "multi";
    }
    const groupId = nextMode === "group" ? String(scopeState.groupId || "").trim() : "";
    let scopeLabel = "全部账本";
    if (nextMode === "group" && groupId) {
      const g = (this.data.statGroups || []).find((x) => x.id === groupId);
      scopeLabel = g && g.name ? g.name : analyzeScope.buildScopeLabel(ledgers, ledgerIds);
    } else if (nextMode !== "all") {
      scopeLabel = analyzeScope.buildScopeLabel(ledgers, ledgerIds);
    }
    const persisted = {
      mode: nextMode,
      ledgerIds: nextMode === "all" ? [] : ledgerIds,
      groupId,
    };
    analyzeScope.writeLastAnalyzeScope(persisted);
    this._savedScopeState = persisted;
    this.setData(
      {
        scopeMode: nextMode,
        selectedLedgerIds: persisted.ledgerIds,
        activeGroupId: groupId,
        scopeLabel,
        scopeLedgerRows: analyzeScope.buildLedgerPickerRows(ledgers, persisted.ledgerIds),
        scopeDraftIds: persisted.ledgerIds.length
          ? persisted.ledgerIds.slice()
          : ledgers.map((x) => String(x._id || "")).filter(Boolean),
        scopeSheetOpen: false,
      },
      () => {
        this.setCustomTabBarHidden(false);
        if (opts.reload !== false) {
          this.rebuildPeriodChips();
        }
      }
    );
    return true;
  },

  onScopePickerOpen() {
    this.destroyF2Charts();
    const ledgers = this.data.ledgers || [];
    const draft =
      this.data.selectedLedgerIds && this.data.selectedLedgerIds.length
        ? this.data.selectedLedgerIds.slice()
        : ledgers.map((x) => String(x._id || "")).filter(Boolean);
    this.setData({
      scopeSheetOpen: true,
      scopeDraftIds: draft,
      scopeLedgerRows: analyzeScope.buildLedgerPickerRows(ledgers, draft),
      statGroups: analyzeScope.enrichStatGroupsForDisplay(
        analyzeScope.readAnalyzeStatGroups(),
        ledgers
      ),
    });
    this.setCustomTabBarHidden(true);
  },

  onScopePickerClose() {
    this.setData({ scopeSheetOpen: false }, () => {
      wx.nextTick(() => {
        setTimeout(() => {
          this.refreshF2Charts();
        }, 32);
      });
    });
    this.setCustomTabBarHidden(false);
  },

  onScopeQuickAll() {
    this.applyScopeState({ mode: "all", ledgerIds: [], groupId: "" });
  },

  onScopeGroupTap(e) {
    const groupId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || "").trim();
    const group = (this.data.statGroups || []).find((g) => g.id === groupId);
    if (!group || !group.validLedgerIds || !group.validLedgerIds.length) {
      wx.showToast({ title: "该组合暂无可用账本", icon: "none" });
      return;
    }
    this.applyScopeState({
      mode: "group",
      ledgerIds: group.validLedgerIds.slice(),
      groupId: group.id,
    });
  },

  onScopeGroupDelete(e) {
    const groupId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || "").trim();
    if (!groupId) {
      return;
    }
    wx.showModal({
      title: "删除组合",
      content: "确定删除该统计组合？",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const next = analyzeScope.readAnalyzeStatGroups().filter((g) => g.id !== groupId);
        analyzeScope.writeAnalyzeStatGroups(next);
        const statGroups = analyzeScope.enrichStatGroupsForDisplay(next, this.data.ledgers);
        const patch = { statGroups };
        if (this.data.activeGroupId === groupId) {
          patch.activeGroupId = "";
        }
        this.setData(patch);
      },
    });
  },

  onScopeGroupRename(e) {
    const groupId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || "").trim();
    const group = (this.data.statGroups || []).find((g) => g.id === groupId);
    if (!group) {
      return;
    }
    wx.showModal({
      title: "重命名组合",
      editable: true,
      placeholderText: "组合名称",
      content: group.name,
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = String(res.content || "").trim();
        if (!name) {
          wx.showToast({ title: "名称不能为空", icon: "none" });
          return;
        }
        const groups = analyzeScope.readAnalyzeStatGroups().map((g) =>
          g.id === groupId ? { ...g, name, updatedAt: Date.now() } : g
        );
        analyzeScope.writeAnalyzeStatGroups(groups);
        const statGroups = analyzeScope.enrichStatGroupsForDisplay(groups, this.data.ledgers);
        const patch = { statGroups };
        if (this.data.activeGroupId === groupId) {
          patch.scopeLabel = name;
        }
        this.setData(patch);
      },
    });
  },

  onScopeLedgerToggle(e) {
    const ledgerId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || "").trim();
    if (!ledgerId) {
      return;
    }
    const draft = (this.data.scopeDraftIds || []).slice();
    const idx = draft.indexOf(ledgerId);
    if (idx >= 0) {
      draft.splice(idx, 1);
    } else {
      draft.push(ledgerId);
    }
    this.setData({
      scopeDraftIds: draft,
      scopeLedgerRows: analyzeScope.buildLedgerPickerRows(this.data.ledgers, draft),
    });
  },

  onScopeApplyMulti() {
    const draft = analyzeScope.pruneLedgerIds(this.data.ledgers, this.data.scopeDraftIds);
    if (!draft.length) {
      wx.showToast({ title: "请至少选择一个账本", icon: "none" });
      return;
    }
    this.applyScopeState({ mode: "multi", ledgerIds: draft, groupId: "" });
  },

  onScopeSaveGroup() {
    const draft = analyzeScope.pruneLedgerIds(this.data.ledgers, this.data.scopeDraftIds);
    if (!draft.length) {
      wx.showToast({ title: "请先勾选账本", icon: "none" });
      return;
    }
    wx.showModal({
      title: "保存统计组合",
      editable: true,
      placeholderText: "如：家庭开支组",
      content: "",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = String(res.content || "").trim();
        if (!name) {
          wx.showToast({ title: "名称不能为空", icon: "none" });
          return;
        }
        const groups = analyzeScope.readAnalyzeStatGroups();
        const item = {
          id: analyzeScope.genStatGroupId(),
          name,
          ledgerIds: draft.slice(),
          updatedAt: Date.now(),
        };
        groups.push(item);
        analyzeScope.writeAnalyzeStatGroups(groups);
        const statGroups = analyzeScope.enrichStatGroupsForDisplay(groups, this.data.ledgers);
        this.setData({ statGroups });
        wx.showToast({ title: "已保存", icon: "success" });
        this.applyScopeState({
          mode: "group",
          ledgerIds: draft.slice(),
          groupId: item.id,
        });
      },
    });
  },

  persistAnalyzeFilters() {
    writeLastAnalyzeFilters(this.data);
  },

  rebuildPeriodChips(options) {
    const opts = options || {};
    const { range, ledgers, todayYmd, scopeMode, selectedLedgerIds } = this.data;
    let createdMs;
    if (scopeMode === "all") {
      const list = (ledgers || []).map((x) => readLedgerCreatedMs(x));
      createdMs = list.length ? Math.min(...list) : Date.now();
    } else {
      const idSet = new Set(selectedLedgerIds || []);
      const picked = (ledgers || []).filter((x) => idSet.has(String(x._id || "")));
      const list = picked.map((x) => readLedgerCreatedMs(x));
      createdMs = list.length ? Math.min(...list) : Date.now();
    }
    let chips = [];
    if (range === "month") {
      chips = buildMonthPeriodChips(createdMs);
    } else if (range === "year") {
      chips = buildYearPeriodChips(createdMs);
    } else {
      chips = buildWeekPeriodChips(createdMs);
    }
    let sel = {
      selectedYear: this.data.selectedYear,
      selectedMonth: this.data.selectedMonth,
      weekAnchorDate: this.data.weekAnchorDate,
      monthPickerValue: this.data.monthPickerValue,
      yearPickerValue: this.data.yearPickerValue,
    };
    if (opts.defaultToCurrent) {
      Object.assign(sel, pickDefaultTimeSelection(range));
    }
    sel = ensureSelectionInChips(chips, range, sel);
    const marked = markPeriodChipsActive(
      chips,
      sel.selectedYear,
      sel.selectedMonth,
      sel.weekAnchorDate
    );
    const baseYmd = todayYmd || formatYmd(new Date());
    const weekQuick = weekQuickState(baseYmd, sel.weekAnchorDate);
    const monthQuick = monthQuickState(baseYmd, sel.selectedYear, sel.selectedMonth);
    const periodScrollIntoView = marked.length
      ? `period-chip-${marked[marked.length - 1].key}`
      : "";
    this.setData(
      {
        periodChips: marked,
        periodChipCount: marked.length,
        periodScrollIntoView,
        selectedYear: sel.selectedYear,
        selectedMonth: sel.selectedMonth,
        weekAnchorDate: sel.weekAnchorDate,
        monthPickerValue: sel.monthPickerValue || this.data.monthPickerValue,
        yearPickerValue: sel.yearPickerValue || this.data.yearPickerValue,
        weekQuick,
        monthQuick,
      },
      () => {
        this.persistAnalyzeFilters();
        this.load();
      }
    );
  },

  load() {
    if (!this.ensureEnv()) {
      return;
    }
    const scopeState = this.getScopeStateFromData();
    if (!analyzeScope.isScopeLoadable(scopeState)) {
      this.setData({ loading: false, listLoading: false });
      return;
    }
    const isFirstLoad = !this._loadedOnce;
    if (isFirstLoad) {
      this.setData({ loading: true, listLoading: false });
    } else {
      this.setData({ listLoading: true });
    }
    const { range, selectedYear, selectedMonth, weekAnchorDate } = this.data;
    const callPayload = {
      type: "analyzeLedger",
      range,
      year: selectedYear,
      month: selectedMonth,
      weekAnchorDate,
      ...analyzeScope.buildAnalyzeCallScope(scopeState),
    };
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: callPayload,
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          const errMsg = String(r.errMsg || "");
          if (/账本不存在|无权访问/.test(errMsg)) {
            this.refreshLedgersAndLoad();
            return;
          }
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.destroyF2Charts();
          this.setData({
            loading: false,
            listLoading: false,
            showLineChart: false,
            showPieChart: false,
            trendPoints: [],
            chartPieRowsExpense: [],
            chartPieRowsIncome: [],
            pieChartCurrentEmpty: false,
          });
          return;
        }
        const netYuan = r.netYuan != null ? r.netYuan : r.totalYuan || "0.00";
        const netStr = String(netYuan).trim();
        let netTone = "net-zero";
        if (netStr.startsWith("+")) {
          netTone = "net-pos";
        } else if (netStr.startsWith("-")) {
          netTone = "net-neg";
        }
        const groupsCategory = mapGroupsForList(r.groups || []);
        const groupsPerson = mapGroupsForList(
          Array.isArray(r.groupsByPerson) ? r.groupsByPerson : []
        );
        const nextYear = toInt(r.selectedYear) || selectedYear;
        const nextMonth = toInt(r.selectedMonth) || selectedMonth;
        const nextWeekAnchorDate = r.weekAnchorDate || weekAnchorDate;
        const nextWeekQuick = weekQuickState(this.data.todayYmd, nextWeekAnchorDate);
        const nextMonthQuick = monthQuickState(this.data.todayYmd, nextYear, nextMonth);
        const insightText = buildInsightText({
          txCount: r.txCount != null ? r.txCount : 0,
          range,
          rangeLabel: r.rangeLabel || "",
          netYuan,
          totalExpenseYuan: r.totalExpenseYuan || "0.00",
          totalIncomeYuan: r.totalIncomeYuan || "0.00",
          groups: r.groups || [],
          groupBy: "category",
          compareHint: r.compareHint || "",
          compareRangeLabel: r.compareRangeLabel || "",
          compareTxCount: r.compareTxCount != null ? Number(r.compareTxCount) : 0,
          compareTotalExpenseYuan: r.compareTotalExpenseYuan || "0.00",
          compareNetYuan: r.compareNetYuan || "0.00",
        });
        const budgetVs = buildBudgetVsFields(r, range);
        const rawGroups = r.groups || [];
        const trendPoints = Array.isArray(r.trendPoints) ? r.trendPoints : [];
        const hasPieApi =
          Array.isArray(r.pieGroupsExpense) && Array.isArray(r.pieGroupsIncome);
        const pieExpenseSrc = hasPieApi
          ? r.pieGroupsExpense
          : splitSignedGroupsForPieFallback(rawGroups, "expense");
        const pieIncomeSrc = hasPieApi
          ? r.pieGroupsIncome
          : splitSignedGroupsForPieFallback(rawGroups, "income");
        const chartPieRowsExpense = buildChartPieRows(pieExpenseSrc);
        const chartPieRowsIncome = buildChartPieRows(pieIncomeSrc);
        const tk = this.data.trendKind === "income" ? "income" : "expense";
        const pieChartCurrentEmpty =
          tk === "income" ? chartPieRowsIncome.length === 0 : chartPieRowsExpense.length === 0;
        const periodChipsMarked = markPeriodChipsActive(
          this.data.periodChips,
          nextYear,
          nextMonth,
          nextWeekAnchorDate
        );
        this.setData(
          {
            loading: false,
            listLoading: false,
            scopeLabel: r.ledgerName || this.data.scopeLabel || "",
            rangeLabel: r.rangeLabel || "",
            selectedYear: nextYear,
            selectedMonth: nextMonth,
            weekAnchorDate: nextWeekAnchorDate,
            monthPickerValue: `${nextYear}-${pad2(nextMonth)}`,
            yearPickerValue: `${nextYear}`,
            periodChips: periodChipsMarked,
            weekQuick: nextWeekQuick,
            monthQuick: nextMonthQuick,
            netAmountDisplay: yuanWithCurrency(netYuan),
            netTone,
            totalExpenseYuan: r.totalExpenseYuan || "0.00",
            totalIncomeYuan: r.totalIncomeYuan || "0.00",
            txCount: r.txCount != null ? r.txCount : 0,
            groupsCategory,
            groupsPerson,
            insightText,
            trendPoints,
            chartPieRowsExpense,
            chartPieRowsIncome,
            pieChartCurrentEmpty,
            showLineChart: trendPoints.length > 0,
            showPieChart: chartPieRowsExpense.length > 0 || chartPieRowsIncome.length > 0,
            txDataTruncated: !!r.txDataTruncated,
            txDataTruncatedHint: String(r.txDataTruncatedHint || ""),
            ...budgetVs,
          },
          () => {
            wx.nextTick(() => {
              setTimeout(() => {
                this.refreshF2Charts();
              }, 32);
            });
          }
        );
        this._resolveGroupsPersonAvatarUrls(groupsPerson).catch(() => {});
        this.persistAnalyzeFilters();
        this._loadedOnce = true;
      })
      .catch(() => {
        wx.showToast({ title: "请上传云函数 ledgerFunctions", icon: "none" });
        this.setData({ loading: false, listLoading: false });
      });
  },

  async _resolveGroupsPersonAvatarUrls(groupsPersonSnapshot) {
    if (!Array.isArray(groupsPersonSnapshot) || !groupsPersonSnapshot.length) {
      return;
    }
    const token = (this._avatarResolveToken = (this._avatarResolveToken || 0) + 1);
    const uniqueCloudUrls = [
      ...new Set(
        groupsPersonSnapshot
          .map((g) => normalizeAvatarUrl(g && g.avatarUrl))
          .filter((u) => u && isCloudAvatarUrl(u))
      ),
    ];
    if (!uniqueCloudUrls.length) {
      return;
    }
    if (!this._avatarTempUrlCache) {
      this._avatarTempUrlCache = {};
    }
    const need = uniqueCloudUrls.filter((u) => !this._avatarTempUrlCache[u]);
    if (need.length) {
      const res = await wx.cloud.getTempFileURL({ fileList: need });
      const fileList = (res && res.fileList) || [];
      for (let i = 0; i < need.length; i += 1) {
        const item = fileList[i] || {};
        const temp = normalizeAvatarUrl(item.tempFileURL || "");
        const fileId = normalizeAvatarUrl(item.fileID || item.fileId || "");
        if (temp) {
          if (fileId) {
            this._avatarTempUrlCache[fileId] = temp;
          } else {
            this._avatarTempUrlCache[need[i]] = temp;
          }
        }
      }
    }
    if (token !== this._avatarResolveToken) {
      return;
    }
    const replaced = (groupsPersonSnapshot || []).map((g) => {
      const src = normalizeAvatarUrl(g && g.avatarUrl);
      if (src && isCloudAvatarUrl(src) && this._avatarTempUrlCache[src]) {
        return { ...g, avatarUrl: this._avatarTempUrlCache[src] };
      }
      return g;
    });
    this.setData({ groupsPerson: replaced });
  },

  onRangeTap(e) {
    const range = e.currentTarget.dataset.range;
    if (!range || range === this.data.range) {
      return;
    }
    this.setData({ range }, () => this.rebuildPeriodChips({ defaultToCurrent: true }));
  },

  onHide() {
    this.persistAnalyzeFilters();
  },

  onPeriodChipTap(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const kind = ds.kind;
    if (kind === "month") {
      const year = toInt(ds.year);
      const month = toInt(ds.month);
      if (!year || !month) {
        return;
      }
      const marked = markPeriodChipsActive(
        this.data.periodChips,
        year,
        month,
        this.data.weekAnchorDate
      );
      this.setData(
        {
          selectedYear: year,
          selectedMonth: month,
          monthPickerValue: `${year}-${pad2(month)}`,
          periodChips: marked,
          weekQuick: weekQuickState(this.data.todayYmd, this.data.weekAnchorDate),
          monthQuick: monthQuickState(this.data.todayYmd, year, month),
        },
        () => {
          this.persistAnalyzeFilters();
          this.load();
        }
      );
      return;
    }
    if (kind === "year") {
      const year = toInt(ds.year);
      if (!year) {
        return;
      }
      const marked = markPeriodChipsActive(
        this.data.periodChips,
        year,
        this.data.selectedMonth,
        this.data.weekAnchorDate
      );
      this.setData(
        {
          selectedYear: year,
          yearPickerValue: `${year}`,
          periodChips: marked,
          monthQuick: monthQuickState(this.data.todayYmd, year, this.data.selectedMonth),
        },
        () => {
          this.persistAnalyzeFilters();
          this.load();
        }
      );
      return;
    }
    if (kind === "week") {
      const monday = String(ds.monday || "").trim();
      if (!parseYmd(monday)) {
        return;
      }
      const marked = markPeriodChipsActive(
        this.data.periodChips,
        this.data.selectedYear,
        this.data.selectedMonth,
        monday
      );
      this.setData(
        {
          weekAnchorDate: monday,
          periodChips: marked,
          weekQuick: weekQuickState(this.data.todayYmd, monday),
        },
        () => {
          this.persistAnalyzeFilters();
          this.load();
        }
      );
    }
  },

  onTrendKindTap(e) {
    const k = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.kind : "";
    if (k !== "income" && k !== "expense") {
      return;
    }
    if (k === this.data.trendKind) {
      return;
    }
    const pieChartCurrentEmpty =
      k === "income"
        ? (this.data.chartPieRowsIncome || []).length === 0
        : (this.data.chartPieRowsExpense || []).length === 0;
    this.setData({ trendKind: k, pieChartCurrentEmpty }, () => {
      this.persistAnalyzeFilters();
      wx.nextTick(() => {
        setTimeout(() => {
          this.refreshF2Charts();
        }, 32);
      });
    });
  },

  onGroupRowTap(e) {
    const key = e.currentTarget.dataset.key;
    const dim = e.currentTarget.dataset.dim;
    const groupBy = dim === "person" ? "person" : "category";
    if (key == null || key === "") {
      return;
    }
    const scopeState = this.getScopeStateFromData();
    if (!analyzeScope.isScopeLoadable(scopeState)) {
      return;
    }
    const { range, selectedYear, selectedMonth, weekAnchorDate } = this.data;
    const scopeParam = analyzeScope.buildAnalyzeScopeUrlParam(scopeState);
    wx.navigateTo({
      url: `/pages/ledger-analytics-drill/ledger-analytics-drill?range=${range}&groupBy=${groupBy}&year=${selectedYear}&month=${selectedMonth}&weekAnchorDate=${encodeURIComponent(
        weekAnchorDate
      )}&key=${encodeURIComponent(String(key))}&${scopeParam}`,
    });
  },

  destroyF2Charts() {
    const keys = ["_f2Line", "_f2Pie"];
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const c = this[k];
      if (c && typeof c.destroy === "function") {
        try {
          c.destroy();
        } catch (e) {
          // ignore
        }
      }
      this[k] = null;
    }
  },

  refreshF2Charts() {
    if (this.data.loading || this.data.scopeSheetOpen) {
      return;
    }
    if (!this.data.showLineChart && !this.data.showPieChart) {
      return;
    }
    this.destroyF2Charts();
    const self = this;
    const sys = wx.getSystemInfoSync();
    const pr = sys.pixelRatio || 2;
    if (this.data.showLineChart) {
      const comp = this.selectComponent("#ff-line");
      if (comp && typeof comp.init === "function") {
        const kind = this.data.trendKind === "income" ? "income" : "expense";
        const src = this.data.trendPoints || [];
        const trend = src.map((p) => ({
          x: p.x,
          amt: trendPointAmt(p, kind),
          dateKey: p.dateKey || "",
        }));
        const lineColor = kind === "income" ? "#0066ff" : "#e54545";
        const tooltipName = kind === "income" ? "收入(元)" : "支出(元)";
        comp.init((canvas, width, height, F2) => {
          const w = width > 16 ? width : (sys.windowWidth || 375) - 48;
          const h = height > 16 ? height : 240;
          const chart = new F2.Chart({ el: canvas, width: w, height: h, pixelRatio: pr });
          chart.source(trend, {
            amt: { tickCount: 5, nice: true, min: 0 },
          });
          chart.axis("x", {
            label(text, idx) {
              if (trend.length > 14) {
                const step = Math.ceil(trend.length / 6);
                return idx % step === 0 ? text : "";
              }
              return text;
            },
            labelOffset: 6,
          });
          chart.tooltip({
            showCrosshairs: true,
            onShow(ev) {
              const items = ev.items || [];
              if (items[0]) {
                items[0].name = tooltipName;
              }
            },
          });
          chart.line().position("x*amt").color(lineColor).shape("smooth");
          chart.point().position("x*amt").color(lineColor);
          chart.render();
          self._f2Line = chart;
          return chart;
        });
      }
    }
    if (this.data.showPieChart) {
      const kind = this.data.trendKind === "income" ? "income" : "expense";
      const rows =
        kind === "income" ? this.data.chartPieRowsIncome || [] : this.data.chartPieRowsExpense || [];
      const comp = this.selectComponent("#ff-pie");
      if (rows.length && comp && typeof comp.init === "function") {
        comp.init((canvas, width, height, F2) => {
          const w = width > 16 ? width : (sys.windowWidth || 375) - 48;
          const h = height > 16 ? height : 240;
          const chart = new F2.Chart({ el: canvas, width: w, height: h, pixelRatio: pr });
          chart.source(rows);
          chart.legend({ position: "bottom", align: "center", itemMarginBottom: 4 });
          chart.coord("polar", {
            transposed: true,
            radius: 0.82,
            innerRadius: 0.45,
          });
          chart.axis(false);
          chart.tooltip(false);
          chart.interval().position("k*value").color("type", CHART_PALETTE).adjust("stack");
          chart.render();
          self._f2Pie = chart;
          return chart;
        });
      }
    }
  },

  onUnload() {
    this.destroyF2Charts();
  },
});
