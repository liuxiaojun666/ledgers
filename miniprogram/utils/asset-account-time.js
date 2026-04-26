/**
 * 与云函数 `readAssetAccountOpenedAtMs` 一致：单账户下资产记录最早可记时间（本地毫秒）。
 * 入参为 `listAssetAccounts` / `getAssetAccount` 返回的账户行（含 `openedAtMs`、可选 `createdAt`）。
 */
const ASSET_BOOKED_AT_FLOOR_FALLBACK_MS = Date.UTC(2000, 0, 1);

function readDateMsLoose(v) {
  if (v == null || v === "") {
    return NaN;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function readAccountBookedAtFloorMs(account) {
  if (!account) {
    return ASSET_BOOKED_AT_FLOOR_FALLBACK_MS;
  }
  if (account.openedAtMs != null) {
    const n = Math.floor(Number(account.openedAtMs));
    if (Number.isFinite(n)) {
      return n;
    }
  }
  const c = readDateMsLoose(account.createdAt);
  if (Number.isFinite(c)) {
    return c;
  }
  return ASSET_BOOKED_AT_FLOOR_FALLBACK_MS;
}

function msToYmdLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ymdToLocalDayStartMs(ymd) {
  const parts = String(ymd || "")
    .split("-")
    .map((x) => parseInt(x, 10));
  if (parts.length < 3) {
    return NaN;
  }
  const [y, m, d] = parts;
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return NaN;
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** 日期字符串 ymd 若早于 minYmd（同日或更晚为合法），则取 minYmd */
function clampYmdToMin(ymd, minYmd) {
  if (!minYmd) {
    return ymd;
  }
  const a = ymdToLocalDayStartMs(ymd);
  const b = ymdToLocalDayStartMs(minYmd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return ymd;
  }
  return a < b ? minYmd : ymd;
}

/**
 * 最终提交前：与云函数 `assertBookedAtNotBeforeAccountOpen` 一致（不低于开户时刻的毫秒数）。
 * 多账户场景传入 max(各户 floorMs)。
 */
function clampBookedAtMsToFloor(bookedAtMs, floorMs) {
  if (!Number.isFinite(bookedAtMs) || !Number.isFinite(floorMs)) {
    return bookedAtMs;
  }
  return Math.max(bookedAtMs, floorMs);
}

module.exports = {
  readAccountBookedAtFloorMs,
  msToYmdLocal,
  ymdToLocalDayStartMs,
  clampYmdToMin,
  clampBookedAtMsToFloor,
  ASSET_BOOKED_AT_FLOOR_FALLBACK_MS,
};
