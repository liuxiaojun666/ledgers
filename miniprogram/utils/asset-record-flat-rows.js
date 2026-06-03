/** 资产变动记录列表：与 asset-records 页一致的格式化与分段（供多单页复用） */

function formatYuan(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

function readDateMs(v) {
  if (v == null || v === "") return NaN;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && !Number.isNaN(t) ? t : NaN;
}

function getRecordTimeMs(item) {
  return readDateMs(item.bookedAt) || readDateMs(item.createdAt) || 0;
}

function formatRecordTimeLabel(item) {
  const ms = readDateMs(item.bookedAt) || readDateMs(item.createdAt);
  if (!Number.isFinite(ms) || ms === 0) {
    return "";
  }
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(
    d.getDate()
  )} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function actionLabel(actionType) {
  if (actionType === "adjust") return "调整";
  if (actionType === "increase") return "增加";
  if (actionType === "decrease") return "减少";
  return actionType || "未知";
}

function directionTag(actionType) {
  if (actionType === "increase") return "转入";
  if (actionType === "decrease") return "转出";
  return "";
}

function unwrapLegacyBrackets(note) {
  let t = String(note || "").trim();
  while (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    const pair =
      (a === "[" && b === "]") || (a === "【" && b === "】") || (a === "(" && b === ")");
    if (!pair) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function isRedundantXferOnlyNote(note, xfer) {
  if (!xfer) return false;
  const inner = unwrapLegacyBrackets(note);
  if (!inner) return false;
  if (inner === `转账${xfer}`) return true;
  const compact = inner.replace(/\s+/g, "");
  return compact === `⇄转账${xfer}` || compact === `转账${xfer}`;
}

function signedBalanceDeltaCents(item) {
  const after = Math.round(Number(item.afterBalanceCents) || 0);
  const rawBefore = Number(item.beforeBalanceCents);
  if (Number.isFinite(rawBefore)) {
    return after - Math.round(rawBefore);
  }
  const at = String(item.actionType || "").trim();
  const mag = Math.abs(Math.round(Number(item.amountCents) || 0));
  if (at === "increase") return mag;
  if (at === "decrease") return -mag;
  return 0;
}

function recordTone(item) {
  if (item.transferPairId) {
    return "transfer";
  }
  const a = String(item.actionType || "");
  if (a === "decrease") return "expense";
  if (a === "increase") return "income";
  if (a === "adjust") return "adjust";
  const d = signedBalanceDeltaCents(item);
  if (d < 0) return "expense";
  if (d > 0) return "income";
  return "neutral";
}

function formatSignedYuanFromDelta(cents) {
  const n = Number(cents) || 0;
  const abs = Math.abs(Math.round(n)) / 100;
  const t = abs.toFixed(2);
  if (n > 0) return `+${t}`;
  if (n < 0) return `-${t}`;
  return t;
}

function yuanColumnFromDelta(deltaCents) {
  const sig = formatSignedYuanFromDelta(deltaCents);
  return `¥ ${sig}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dayKeyLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function sectionLabelFromDay(dayKey, todayKey, yesterdayKey) {
  if (dayKey === todayKey) return "今天";
  if (dayKey === yesterdayKey) return "昨天";
  return dayKey;
}

function groupRecordsIntoFlatRows(records, options) {
  const { todayKey, yesterdayKey } = options || {};
  const out = [];
  let prevDay = "";

  records.forEach((item, idx) => {
    const dk = dayKeyLocal(getRecordTimeMs(item));
    if (!prevDay || dk !== prevDay) {
      prevDay = dk;
      out.push({
        kind: "section",
        sectionKey: dk,
        sectionLabel: sectionLabelFromDay(dk, todayKey, yesterdayKey),
        rk: `s-${dk}`,
      });
    }
    out.push({
      kind: "row",
      rk: `${String(item._id || "")}_${idx}`,
      detail: item,
    });
  });

  return out;
}

function computeTodayYesterdayKeys() {
  const now = new Date();
  const end = now.getTime();
  const dk = dayKeyLocal(end);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(startToday - 86400000);
  return {
    todayKey: dk,
    yesterdayKey: dayKeyLocal(yesterday.getTime()),
  };
}

/**
 * @param {Array} sorted 已按时间倒序
 * @param {{ accountId?: string; accountName?: string; todayKey: string; yesterdayKey: string }} opts
 */
function buildFlatRowsFromRawRecords(sorted, opts) {
  const { accountId = "", accountName = "", todayKey, yesterdayKey } = opts || {};
  const accountIdStr = String(accountId).trim();
  const pageAccountDisplay = String(accountName || "").trim();

  const working = sorted.map((item, idx, arr) => {
    const signedDelta = signedBalanceDeltaCents(item);
    const acctDisplayed = accountIdStr ? pageAccountDisplay : String((item.accountName || "").trim() || "");
    const lbl = actionLabel(item.actionType);
    const xfer = directionTag(item.actionType);
    const actionPart = item.transferPairId ? `⇄ 转账${xfer}` : lbl;
    const firstLineTitle =
      acctDisplayed && actionPart ? `${acctDisplayed} · ${actionPart}` : acctDisplayed || actionPart || "";
    const xferDupNote =
      item.transferPairId && xfer && isRedundantXferOnlyNote(String(item.note || ""), xfer);

    const row = {
      ...item,
      actionLabel: lbl,
      transferDirection: xfer,
      hasTransferPair: !!item.transferPairId,
      amountYuan: formatYuan(item.amountCents),
      afterBalanceYuan: formatYuan(item.afterBalanceCents),
      bookedAtLabel: formatRecordTimeLabel(item),
      signedDeltaCents: signedDelta,
      amtColumn: yuanColumnFromDelta(signedDelta),
      firstLineTitle,
      displayNote: xferDupNote ? "" : String(item.note || "").trim(),
    };
    row.tone = recordTone(row);
    if (!row.hasTransferPair) {
      row.transferRowExtras = "";
      return { ...row, transferGroupPos: "" };
    }
    const prev = arr[idx - 1];
    const next = arr[idx + 1];
    const pairId = row.transferPairId;
    const samePrev = !!(prev && prev.transferPairId === pairId);
    const sameNext = !!(next && next.transferPairId === pairId);
    let transferGroupPos = "single";
    if (samePrev && sameNext) {
      transferGroupPos = "middle";
    } else if (samePrev) {
      transferGroupPos = "end";
    } else if (sameNext) {
      transferGroupPos = "start";
    }
    row.transferRowExtras = `record-row--xfer record-row--xfer-${transferGroupPos}`;
    return { ...row, transferGroupPos };
  });

  return working.length === 0
    ? []
    : groupRecordsIntoFlatRows(working, { todayKey, yesterdayKey });
}

module.exports = {
  buildFlatRowsFromRawRecords,
  computeTodayYesterdayKeys,
  getRecordTimeMs,
};
