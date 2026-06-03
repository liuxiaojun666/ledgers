/** 定时记账：北京时间（Asia/Shanghai）下的下次执行时间计算 */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function getChinaYMDHM(ms = Date.now()) {
  const s = new Date(ms).toLocaleString("sv-SE", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const [datePart, timePart = "00:00:00"] = s.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  return { y, m, d, h: h || 0, mi: mi || 0 };
}

function chinaYMDHMToUtcMs(y, mo, d, h, mi) {
  return new Date(
    `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:00+08:00`
  ).getTime();
}

function chinaWeekdaySun0(y, mo, d) {
  const ms = chinaYMDHMToUtcMs(y, mo, d, 12, 0);
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  })
    .formatToParts(new Date(ms))
    .find((x) => x.type === "weekday");
  const v = w && w.value;
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[v] != null ? map[v] : 0;
}

/** mo 为 1-12 */
function daysInMonth(y, mo) {
  return new Date(y, mo, 0).getDate();
}

function addCalendarDaysChina(y, mo, d, delta) {
  const noon = chinaYMDHMToUtcMs(y, mo, d, 12, 0) + delta * 86400000;
  const p = getChinaYMDHM(noon);
  return { y: p.y, m: p.m, d: p.d };
}

function addCalendarMonthsClampDay(y, mo, d, deltaMonth, clampDay) {
  let nm = mo + deltaMonth;
  let ny = y;
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  while (nm < 1) {
    nm += 12;
    ny -= 1;
  }
  const dim = daysInMonth(ny, nm);
  const day = Math.min(clampDay, dim);
  return { y: ny, m: nm, d: day };
}

function normalizeRecurrence(r) {
  if (
    r === "once" ||
    r === "daily" ||
    r === "weekly" ||
    r === "monthly" ||
    r === "yearly"
  ) {
    return r;
  }
  return "daily";
}

/**
 * 新建时计算首次 nextRunAt（北京时间 0:00 的日历日，不按时分）
 * weekday: 0-6 周日-周六（与小程序 picker 一致）
 * monthDay: 1-28
 * yearMonth: 1-12；yearDay: 1-28（每年重复）
 * onceDate: "YYYY-MM-DD"
 */
function computeInitialNextRun({
  recurrence,
  nowMs,
  weekday,
  monthDay,
  yearMonth,
  yearDay,
  onceYear,
  onceMonth,
  onceDay,
}) {
  const r = normalizeRecurrence(recurrence);
  const p = getChinaYMDHM(nowMs);
  const todayStart = chinaYMDHMToUtcMs(p.y, p.m, p.d, 0, 0);

  if (r === "once") {
    const ms = chinaYMDHMToUtcMs(onceYear, onceMonth, onceDay, 0, 0);
    if (ms < todayStart) {
      return { ok: false, errMsg: "执行日期不能早于今天" };
    }
    return { ok: true, nextRunAtMs: ms };
  }

  if (r === "daily") {
    const ms = chinaYMDHMToUtcMs(p.y, p.m, p.d, 0, 0);
    return { ok: true, nextRunAtMs: ms };
  }

  if (r === "weekly") {
    const wd = (((Number(weekday) || 0) % 7) + 7) % 7;
    let found = null;
    for (let i = 0; i < 21; i += 1) {
      const q = addCalendarDaysChina(p.y, p.m, p.d, i);
      if (chinaWeekdaySun0(q.y, q.m, q.d) !== wd) {
        continue;
      }
      found = chinaYMDHMToUtcMs(q.y, q.m, q.d, 0, 0);
      break;
    }
    if (found == null) {
      return { ok: false, errMsg: "无法计算下次执行时间" };
    }
    return { ok: true, nextRunAtMs: found };
  }

  if (r === "monthly") {
    const md = Math.min(28, Math.max(1, Number(monthDay) || 1));
    let found = null;
    for (let k = 0; k < 36; k += 1) {
      const q = addCalendarMonthsClampDay(p.y, p.m, 1, k, md);
      const dim = daysInMonth(q.y, q.m);
      const dUse = Math.min(md, dim);
      const ms = chinaYMDHMToUtcMs(q.y, q.m, dUse, 0, 0);
      if (ms >= todayStart) {
        found = ms;
        break;
      }
    }
    if (found == null) {
      return { ok: false, errMsg: "无法计算下次执行时间" };
    }
    return { ok: true, nextRunAtMs: found };
  }

  if (r === "yearly") {
    const ym = Math.min(12, Math.max(1, Number(yearMonth) || 1));
    const yd = Math.min(28, Math.max(1, Number(yearDay) || 1));
    let found = null;
    for (let ky = 0; ky < 12; ky += 1) {
      const yTry = p.y + ky;
      const dim = daysInMonth(yTry, ym);
      const dUse = Math.min(yd, dim);
      const ms = chinaYMDHMToUtcMs(yTry, ym, dUse, 0, 0);
      if (ms >= todayStart) {
        found = ms;
        break;
      }
    }
    if (found == null) {
      return { ok: false, errMsg: "无法计算下次执行时间" };
    }
    return { ok: true, nextRunAtMs: found };
  }

  return { ok: false, errMsg: "不支持的重复类型" };
}

function readFirestoreDateMs(v) {
  if (v == null) {
    return NaN;
  }
  if (v instanceof Date) {
    return v.getTime();
  }
  if (typeof v === "object" && typeof v.getTime === "function") {
    return v.getTime();
  }
  if (typeof v === "object" && v._seconds != null) {
    return v._seconds * 1000 + (v._nanoseconds || 0) / 1e6;
  }
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? NaN : t;
}

/** 执行一笔入账后，计算下一次 nextRunAt（均为北京时间当日 0:00）；一次性任务返回 done */
function advanceAfterRun(doc, nowMs) {
  const r = normalizeRecurrence(doc.recurrence);
  const anchor = readFirestoreDateMs(doc.nextRunAt);
  const p = getChinaYMDHM(Number.isFinite(anchor) ? anchor : nowMs);

  if (r === "once") {
    return { done: true, nextRunAtMs: null };
  }

  if (r === "daily") {
    const q = addCalendarDaysChina(p.y, p.m, p.d, 1);
    return {
      done: false,
      nextRunAtMs: chinaYMDHMToUtcMs(q.y, q.m, q.d, 0, 0),
    };
  }

  if (r === "weekly") {
    const q = addCalendarDaysChina(p.y, p.m, p.d, 7);
    return {
      done: false,
      nextRunAtMs: chinaYMDHMToUtcMs(q.y, q.m, q.d, 0, 0),
    };
  }

  if (r === "monthly") {
    const md = Math.min(28, Math.max(1, Number(doc.monthDay) || 1));
    const q = addCalendarMonthsClampDay(p.y, p.m, p.d, 1, md);
    const dim = daysInMonth(q.y, q.m);
    const dUse = Math.min(md, dim);
    return {
      done: false,
      nextRunAtMs: chinaYMDHMToUtcMs(q.y, q.m, dUse, 0, 0),
    };
  }

  if (r === "yearly") {
    const ym = Math.min(12, Math.max(1, Number(doc.yearMonth) || 1));
    const yd = Math.min(28, Math.max(1, Number(doc.yearDay) || 1));
    const ny = p.y + 1;
    const dim = daysInMonth(ny, ym);
    const dUse = Math.min(yd, dim);
    return {
      done: false,
      nextRunAtMs: chinaYMDHMToUtcMs(ny, ym, dUse, 0, 0),
    };
  }

  return { done: true, nextRunAtMs: null };
}

function parseOnceDate(onceDateStr) {
  const s = String(onceDateStr || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    return null;
  }
  const onceYear = Number(m[1]);
  const onceMonth = Number(m[2]);
  const onceDay = Number(m[3]);
  if (
    !Number.isFinite(onceYear) ||
    onceMonth < 1 ||
    onceMonth > 12 ||
    onceDay < 1 ||
    onceDay > 31
  ) {
    return null;
  }
  return { onceYear, onceMonth, onceDay };
}

module.exports = {
  getChinaYMDHM,
  chinaYMDHMToUtcMs,
  normalizeRecurrence,
  computeInitialNextRun,
  advanceAfterRun,
  readFirestoreDateMs,
  parseOnceDate,
};
