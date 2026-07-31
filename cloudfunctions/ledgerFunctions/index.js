/**
 * 协同记账云函数。
 *
 * 集合（本云函数会在首次调用时尝试 createCollection；也可在云开发控制台手动创建）：
 * - ledgers: { name, creatorOpenid, memberOpenids[], categories[], categoryByFlow?: object, createdAt, monthlyBudgetCents?, defaultAssetAccountId?, defaultAssetAccountName?, archived?: boolean }
 *   archived：可选，为 true 时表示账本已归档；默认列表与统计「全部账本」不含已归档；创建者可归档/恢复，**仅已归档账本可物理删除**。
 *   categoryByFlow：可选，{ [分类名]: "income"|"expense" }，仅用于**非**预置名自定义分类的收支归属；记一笔/定时等按收入与支出只展示各自分类，并与流水 flow 一致校验。
 *   monthlyBudgetCents：可选，正整数（分），表示「自然月」支出预算上限，由创建者在账本管理中设置。
 *   defaultAssetAccountId / defaultAssetAccountName：可选，账本默认关联资产账户（仅创建者可设置；须为本人非归档户主账户）；记一笔/新建定时在新增时默认选中，用户仍可改为不关联或其它账户。
 * - ledger_members: 文档 _id = `${openid}_${ledgerId}`，{ ledgerId, openid, role, joinedAt, pinned?: boolean, pinnedAt?: Date }
 *   pinned：可选，当前用户对该账本的置顶偏好（仅影响本人 listLedgers 排序）；pinnedAt 为最近一次置顶时刻。
 * - transactions: { ledgerId, amountCents, flow, category, note, createdByOpenid, createdAt, bookedAt? }
 *   可选：assetAccountId、assetAccountName（记一笔选资产时写入；名称为快照）；sourceAssetEffectCents（有符号分，该条流水对所选资产账户余额的净影响）、primaryAssetRecordId（首笔联动资产记录）。
 *   可选：attachments（图片附件数组，最多 9 项；每项 { fileID, name?, size?, contentType? }，fileID 为云存储 cloud://；仅图片）。
 *   关联资产时记一笔成功会写 assets 侧 `asset_records` 并更新余额；编辑/删除流水时会再追加一条带 `sourceLedger*` 的变动（不删改历史资产行，用新行表达冲销/调整）。
 *   bookedAt 为用户选择的「记账发生时间」至毫秒（记一笔为日期+时刻；新纪录在确认时用当前秒/毫秒以区分同一分钟内多条）；列表/统计按 bookedAt ?? createdAt。
 *   amountCents 为正整数（绝对值）；flow 为 expense | income，缺省按 expense。
 *   编辑/删除流水时会对被移除或整单删除的附件 fileID 尽力调用 cloud.deleteFile（失败不影响主流程）。
 *
 * 小程序端流水列表已改为「云函数 listTransactions + 页面 onShow 刷新」，不再使用客户端 watch，
 * 因此一般无需为 transactions 配置小程序可读权限，也不会再触发规则里 get(ledgers) 的 document.get:fail。
 * listTransactions：按 createdAt 倒序拉取至多 1000 条（与统计汇总上限一致），再按 bookedAt ?? createdAt 倒序返回；
 * 返回 txTotalCount / txListTruncated / txListTruncatedHint（总数超 1000 时供详情页提示）；若库侧缺少组合索引则回退为分页扫全表后排序截取。
 * analyzeLedger / listGroupTransactions：单账本每本最多 1000 条参与统计；超限时返回 txDataTruncated / txDataTruncatedHint。
 * 若你自行改为客户端直连读 transactions，才需要为 transactions / ledgers 配置自定义规则（见下）。
 *
 * transactions（仅在你客户端直连读时需要）：
 * { "read": "auth.openid in get(`database.ledgers.${doc.ledgerId}`).memberOpenids", "write": false }
 *
 * ledgers（配合上面 get 时，成员需可读账本文档）：
 * { "read": "auth.openid in doc.memberOpenids", "write": false }
 *
 * ledger_members 可保持「所有用户不可读写」，仅云函数访问。
 *
 * analyzeLedger（统计页数据）：按周/月/年；groups / groupsByPerson 为分类与成员的「支出排行」（仅支出流水）；汇总区净额等仍含收支；另返回 trendPoints、饼图 pieGroups* 等。入参可传 `scope: "all"`（或 `allLedgers: true`）以汇总当前用户**全部**可访问未归档账本；可传 `ledgerIds: string[]` 自定义合并多个账本（成员校验、剔除已归档；月预算为所选账本预算之和）；分账本时仍传 `ledgerId`。
 * listGroupTransactions：`scope: "all"` 或 `ledgerIds` 时与统计范围一致汇总，明细行带 `ledgerId` 以便跳转记一笔；分账本时仍带 `ledgerId`。
 * getTransaction / updateTransaction / deleteTransaction：仅流水记录人可读取（编辑页）/修改/删除；无 createdByOpenid 的历史记录仅账本创建者可改删。
 * archiveLedger：仅创建者可归档/恢复账本（`archived` 默认 true 表归档，false 表恢复）。
 * deleteLedger：仅创建者可删账本，且须**已归档**；删除该账本下全部流水与成员关联。
 * exitLedger：非创建者可主动退出账本，会清理该成员在账本内的成员关系与定时任务。
 * listLedgers：默认仅返回未归档账本（库查询 `archived: _.neq(true)`，**无 archived 字段的旧账本视为未归档**）；`archivedOnly: true` 仅返回 `archived: true`。若当前用户作为成员**完全无账本**，会自动创建默认账本「我的账本」后再返回列表（仅非 archivedOnly 查询）。
 *   每条含当月（北京时间自然月）收入/支出分汇总 monthIncomeCents/monthExpenseCents、monthSummaryLabel，
 *   口径与统计一致（bookedAt ?? createdAt；每账本最多拉取 1000 条流水参与汇总，与 analyzeLedger 一致）。
 *   列表按当前用户置顶偏好排序：pinned 为真者在前（同组内按 pinnedAt 新在前），其余按 createdAt 新在前。
 * setLedgerPinned：成员可设置本人对该账本的置顶/取消置顶（写入 ledger_members.pinned / pinnedAt）。
 * addLedgerCategory / removeLedgerCategory：会同步到当前用户参与的全部账本（不仅是传入的 ledgerId）。
 * addLedgerCategory / removeLedgerCategory：在当前用户参与的全部账本上同步增删分类（入口需带任一账本 ledgerId 做权限校验）。
 * deleteLedger：仅创建者可删；删除该账本下全部流水与 ledger_members 记录。
 *
 * ledger_schedules：定时记账规则；定时触发器（见 config.json）每天跑一次，按 nextRunAt（北京时间日历日 0 点）入账；保存后若已到期会立即尝试执行一次。可选 assetAccountId/assetAccountName：执行入账时与记一笔同口径写入流水并联动资产（见 insertLedgerTransaction + applyLedgerCreateAssetLink）。
 *
 * 资产变动记录：小程序仅展示列表，不提供改删；`updateAssetRecord` / `deleteAssetRecord` 入口返回失败，修正请新增 `createAssetRecord` 或转账等。
 * 同账户新写入的 `asset_records.bookedAt` 不得早于该户 `openedAtMs` / `createdAt`（`createAssetRecord` / `createAssetTransfer` / 记一笔或编辑流水关联资产等路径校验；关联流水见 `insertLedgerTransaction` + `appendAssetRecordFromLedgerSource`）。
 * listAssetAccounts、getAssetDashboard：账户顺序按 `balanceCents` 降序，同分按 `updatedAt` 新在前；库内 `sortOrder` 仅新建默认等兼容，不再作为列表排序主键。`listAssetAccounts` 可选 `archivedOnly: true` 仅查已归档；默认（或与 `includeArchived: true` 同传时以 `archivedOnly` 优先）为**未归档**（`archived` 非真）；`includeArchived: true` 且**未**传 `archivedOnly` 时为含已归档的**全部**（兼容旧客户端）。`getAssetDashboard` 的 `totalAssetsCents` / `totalLiabilitiesCents` / `netWorthCents` 与类型分组仅统计 `includeInNetWorth !== false` 的账户，列表仍返回全部可见账户。成功时还返回 `monthOverPrevMonthNetWorthPct`：当前用户 `asset_snapshots` 按 `month` 排序的最后两个月净资产快照的环比小数百分数，不足两个月或上期净资产近似 0 时为 `null`（不在此接口内触发 `rebuildAssetSnapshots`）。
 * asset_snapshots：重算时按月聚合状态全量走内存，**仅落库最近 ASSET_SNAPSHOT_PERSIST_MAX（与 listNetWorthTrend 条数一致）** 个月。新建账户的期初行 `bookedAt` 为开户时刻，旧数据若曾锚在 2000-01 由 `rebuildAssetAccountBalanceChain` 在可安全时修正。
 */
const cloud = require("wx-server-sdk");
const scheduleLib = require("./scheduleLib");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTION_NAMES = [
  "ledgers",
  "ledger_members",
  "ledger_join_requests",
  "ledger_invites",
  "transactions",
  "ledger_schedules",
  "user_profiles",
  "asset_accounts",
  "asset_records",
  "asset_snapshots",
  "asset_account_shares",
  "asset_account_share_invites",
];
const MAX_SCHEDULES_PER_USER = 40;
const INVITE_CODE_LEN = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 与 listNetWorthTrend 的 .limit(200) 一致；rebuild 仅落库这些月，避免月跨度过大时逐月 set 过多次导致云函数 20s 超时 */
const ASSET_SNAPSHOT_PERSIST_MAX = 200;
const ASSET_RECORD_BOOKED_AT_MIN_MS = Date.UTC(2000, 0, 1);
const ASSET_SNAPSHOT_WRITE_BATCH = 16;
const DB_REMOVE_CONCURRENCY = 16;
/** 与 analyzeLedger / listLedgers 月汇总一致：单账本流水列表与统计参与条数上限 */
const LEDGER_TX_LIST_MAX = 1000;
const LEDGER_TX_QUERY_BATCH = 100;

async function countLedgerTransactions(ledgerId) {
  const id = normalizeLedgerId(ledgerId);
  if (!id) {
    return 0;
  }
  try {
    const res = await db.collection("transactions").where({ ledgerId: id }).count();
    return Number(res && res.total) || 0;
  } catch (e) {
    return 0;
  }
}

function buildTxListTruncatedHint(totalCount) {
  const n = Number(totalCount) || 0;
  if (n <= LEDGER_TX_LIST_MAX) {
    return "";
  }
  return `本账本共有 ${n} 条流水，已超过 ${LEDGER_TX_LIST_MAX} 条上限，此处仅展示最新 ${LEDGER_TX_LIST_MAX} 条。`;
}

function buildTxAnalyzeTruncatedHint(truncatedLedgerCount, totalLedgerCount) {
  const truncated = Number(truncatedLedgerCount) || 0;
  const total = Number(totalLedgerCount) || 0;
  if (truncated <= 0) {
    return "";
  }
  if (total <= 1) {
    return `本账本流水已超过 ${LEDGER_TX_LIST_MAX} 条，当前统计仅基于部分流水，结果可能不完整。`;
  }
  return `所选范围内有 ${truncated} 个账本流水超过 ${LEDGER_TX_LIST_MAX} 条，统计结果可能不完整。`;
}

async function resolveTxTruncationForLedgers(ledgerIdList) {
  const list = (ledgerIdList || []).map((x) => normalizeLedgerId(x)).filter(Boolean);
  let truncatedLedgerCount = 0;
  for (let i = 0; i < list.length; i += 1) {
    const n = await countLedgerTransactions(list[i]);
    if (n > LEDGER_TX_LIST_MAX) {
      truncatedLedgerCount += 1;
    }
  }
  return {
    txDataTruncated: truncatedLedgerCount > 0,
    txDataTruncatedHint: buildTxAnalyzeTruncatedHint(truncatedLedgerCount, list.length),
  };
}

function txTimeMs(tx) {
  if (!tx) {
    return 0;
  }
  const b = tx.bookedAt != null ? new Date(tx.bookedAt).getTime() : NaN;
  if (Number.isFinite(b)) {
    return b;
  }
  const c = tx.createdAt != null ? new Date(tx.createdAt).getTime() : NaN;
  return Number.isFinite(c) ? c : 0;
}

function txOccurredDate(tx) {
  const ms = txTimeMs(tx);
  return ms ? new Date(ms) : null;
}

/** 解析小程序传入的 bookedAtMs；不在合法范围则返回 null */
function parseClientBookedAtDate(ev) {
  const raw = ev.bookedAtMs != null ? Number(ev.bookedAtMs) : NaN;
  if (!Number.isFinite(raw)) {
    return null;
  }
  const ms = Math.floor(raw);
  const MAX = Date.now() + 60 * 60 * 1000;
  if (ms < ASSET_RECORD_BOOKED_AT_MIN_MS || ms > MAX) {
    return null;
  }
  return new Date(ms);
}
function readAssetAccountOpenedAtMs(account) {
  if (!account) {
    return NaN;
  }
  if (account.openedAtMs != null) {
    const n = Math.floor(Number(account.openedAtMs));
    if (Number.isFinite(n)) {
      return n;
    }
  }
  const c = readDateMs(account.createdAt);
  if (Number.isFinite(c)) {
    return c;
  }
  return ASSET_RECORD_BOOKED_AT_MIN_MS;
}
/**
 * 同一账户下新写入的 asset_records.bookedAt 不得早于该账户的创建时刻（`openedAtMs` 或 `createdAt`）。
 */
function assertBookedAtNotBeforeAccountOpen(account, bookedAt, errMsg) {
  const openMs = readAssetAccountOpenedAtMs(account);
  const b =
    bookedAt instanceof Date
      ? bookedAt.getTime()
      : new Date(bookedAt).getTime();
  if (!Number.isFinite(b)) {
    return { ok: false, errMsg: errMsg || "记账时间无效" };
  }
  if (Number.isFinite(openMs) && b < openMs) {
    return { ok: false, errMsg: errMsg || "记账时间不能早于账户创建时间" };
  }
  return { ok: true };
}
function isOpeningAssetRecordRow(row) {
  const n = String((row && row.note) || "").trim();
  return n.indexOf("期初余额") >= 0 && n.indexOf("开户") >= 0;
}
const DEFAULT_INVITE_EXPIRE_HOURS = 24;
const MAX_INVITE_EXPIRE_HOURS = 168;

let collectionsEnsured = false;

async function ensureCollections() {
  if (collectionsEnsured) {
    return;
  }
  for (const name of COLLECTION_NAMES) {
    try {
      await db.createCollection(name);
    } catch (e) {
      // 集合已存在等情况会报错，可忽略
    }
  }
  collectionsEnsured = true;
}

const memberDocId = (openid, ledgerId) => `${openid}_${ledgerId}`;
const joinRequestDocId = (openid, ledgerId) => `${openid}_${ledgerId}`;
const inviteDocId = (ledgerId, inviteCode) => `${ledgerId}_${inviteCode}`;
const assetAccountShareDocId = (memberOpenid, accountId) => `${memberOpenid}_${accountId}`;
const assetAccountShareInviteDocId = (accountId, inviteCode) => `${accountId}_${inviteCode}`;

const DEFAULT_CATEGORIES = [
  "餐饮",
  "早餐",
  "午餐",
  "晚餐",
  "买菜",
  "交通",
  "住房",
  "水电燃气",
  "通讯网络",
  "日用",
  "服饰",
  "购物",
  "医疗",
  "教育",
  "人情",
  "旅行",
  "娱乐",
  "其他",
];

/** 预置收入分类（与 DEFAULT_CATEGORIES 不重复；与支出预置合计 18+6=24 个，单账本分类总数上限制为 MAX_LEDGER_CATEGORIES） */
const DEFAULT_INCOME_CATEGORIES = [
  "工资",
  "奖金",
  "理财",
  "收租",
  "红包",
  "其他收入",
];
const MAX_LEDGER_CATEGORIES = 48;
const CATEGORY_NAME_MAX_LEN = 16;
const LEDGER_NAME_MAX_LEN = 24;
const MAX_MONTHLY_BUDGET_CENTS = 1e12;
const ASSET_NAME_MAX_LEN = 24;
const ASSET_REMARK_MAX_LEN = 120;
const MAX_ASSET_BALANCE_CENTS = 1e14;
const ASSET_ACCOUNT_KINDS = ["asset", "liability"];
const ASSET_ACCOUNT_TYPES = [
  "cash",
  "bank",
  "ewallet",
  "receivable",
  "fixed_asset",
  "credit_card",
  "loan",
  "payable",
  "other",
];
const ASSET_RECORD_ACTIONS = ["adjust", "increase", "decrease"];

function readMonthlyBudgetCents(ledger) {
  if (!ledger || ledger.monthlyBudgetCents == null) {
    return null;
  }
  const n = Math.floor(Number(ledger.monthlyBudgetCents));
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function readLedgerDefaultAssetAccountId(ledger) {
  if (!ledger || ledger.defaultAssetAccountId == null) {
    return null;
  }
  const id = String(ledger.defaultAssetAccountId).trim();
  return id || null;
}

function readLedgerDefaultAssetAccountName(ledger) {
  if (!ledger || ledger.defaultAssetAccountName == null) {
    return null;
  }
  const name = String(ledger.defaultAssetAccountName).trim();
  return name || null;
}

function normalizeLedgerName(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, LEDGER_NAME_MAX_LEN);
}

function normalizeAssetAccountName(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, ASSET_NAME_MAX_LEN);
}

function normalizeAssetAccountRemark(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, ASSET_REMARK_MAX_LEN);
}

function normalizeAssetAccountKind(raw) {
  const kind = String(raw == null ? "" : raw).trim().toLowerCase();
  return ASSET_ACCOUNT_KINDS.includes(kind) ? kind : "";
}

function normalizeAssetAccountType(raw) {
  const type = String(raw == null ? "" : raw).trim().toLowerCase();
  return ASSET_ACCOUNT_TYPES.includes(type) ? type : "";
}

function readAssetBalanceCents(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || Math.abs(n) > MAX_ASSET_BALANCE_CENTS) {
    return NaN;
  }
  return n;
}

function readAssetSortOrder(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) {
    return 100;
  }
  return Math.max(0, Math.min(9999, n));
}

/** 账户列表/总览：按当前余额（分）降序，同额按更新时间新在前 */
function sortAssetAccountRowsByBalanceDesc(rows) {
  const list = (rows || []).slice();
  list.sort((a, b) => {
    const ba = Number(a.balanceCents) || 0;
    const bb = Number(b.balanceCents) || 0;
    if (bb !== ba) {
      return bb - ba;
    }
    const ta = readDateMs(a.updatedAt);
    const tb = readDateMs(b.updatedAt);
    return tb - ta;
  });
  return list;
}

function normalizeAssetRecordAction(raw) {
  const action = String(raw == null ? "" : raw).trim().toLowerCase();
  return ASSET_RECORD_ACTIONS.includes(action) ? action : "";
}

function normalizeAssetRecordNote(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, 200);
}

function parseAssetRecordBookedAt(event) {
  const raw = event.bookedAtMs != null ? Number(event.bookedAtMs) : Date.now();
  if (!Number.isFinite(raw)) {
    return null;
  }
  const ms = Math.floor(raw);
  const MAX = Date.now() + 60 * 60 * 1000;
  if (ms < ASSET_RECORD_BOOKED_AT_MIN_MS || ms > MAX) {
    return null;
  }
  return new Date(ms);
}

function parseAssetLedgerSyncRequest(event, actionType) {
  if (event && event.syncToLedger !== true) {
    return { enabled: false };
  }
  if (actionType === "adjust") {
    return { enabled: false };
  }
  const flow = actionType === "increase" ? "income" : "expense";
  const ledgerId = normalizeLedgerId(event && event.syncLedgerId);
  if (!ledgerId) {
    return { enabled: false, errMsg: "请选择同步账本" };
  }
  const category = String((event && event.syncCategory) == null ? "" : event.syncCategory).trim();
  if (!category) {
    return { enabled: false, errMsg: "请选择同步分类" };
  }
  return {
    enabled: true,
    ledgerId,
    category,
    flow,
  };
}

async function deleteLedgerTransactionIfOwnedByCaller(openid, ledgerId, txId) {
  const id = String(txId == null ? "" : txId).trim();
  if (!id) {
    return { ok: true };
  }
  const g = await assertTransactionInLedger(openid, ledgerId, id);
  if (!g.ok) {
    return { ok: false, errMsg: g.errMsg || "同步流水不存在或无权访问" };
  }
  if (!transactionEditableByCaller(openid, g.tx, g.ledger)) {
    return { ok: false, errMsg: "同步流水不是当前用户创建，无法自动处理" };
  }
  await db.collection("transactions").doc(id).remove();
  return { ok: true };
}

async function getAssetAccountById(ownerOpenid, accountId) {
  const id = String(accountId == null ? "" : accountId).trim();
  if (!id) {
    return null;
  }
  try {
    const res = await db
      .collection("asset_accounts")
      .where({ _id: id, ownerOpenid })
      .limit(1)
      .get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function getAssetAccountRawById(accountId) {
  const id = String(accountId == null ? "" : accountId).trim();
  if (!id) {
    return null;
  }
  try {
    const res = await db.collection("asset_accounts").where({ _id: id }).limit(1).get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function getAssetAccountAccess(openid, accountId) {
  const account = await getAssetAccountRawById(accountId);
  if (!account) {
    return { ok: false, errMsg: "资产账户不存在" };
  }
  const ownerOpenid = String(account.ownerOpenid || "").trim();
  if (!ownerOpenid) {
    return { ok: false, errMsg: "资产账户数据异常" };
  }
  if (ownerOpenid === openid) {
    return { ok: true, role: "owner", ownerOpenid, account };
  }
  const shareId = assetAccountShareDocId(openid, String(account._id || ""));
  const shareRes = await db
    .collection("asset_account_shares")
    .where({ _id: shareId, status: "active" })
    .limit(1)
    .get();
  const share = (shareRes.data && shareRes.data[0]) || null;
  if (!share) {
    return { ok: false, errMsg: "无权访问该资产账户" };
  }
  const role = "viewer";
  return { ok: true, role, ownerOpenid, account };
}

/** 记一笔/改流水时可选关联当前用户自己的资产账户；空字符串表示不关联 */
async function normalizeOptionalAssetLink(openid, raw) {
  const id = raw == null ? "" : String(raw).trim();
  if (!id) {
    return { ok: true, clear: true };
  }
  const access = await getAssetAccountAccess(openid, id);
  if (!access.ok) {
    return { ok: false, errMsg: access.errMsg || "资产账户不存在" };
  }
  if (access.role !== "owner") {
    return { ok: false, errMsg: "共享账户不可关联" };
  }
  const acc = access.account;
  if (acc.archived === true) {
    return { ok: false, errMsg: "该资产账户已归档，无法关联" };
  }
  const name = acc.name != null ? String(acc.name).trim() : "";
  if (!name) {
    return { ok: false, errMsg: "资产账户名称无效" };
  }
  return {
    ok: true,
    clear: false,
    assetAccountId: id,
    assetAccountName: name.slice(0, 64),
    ownerOpenid: access.ownerOpenid,
  };
}

function assetRecordTimeMs(row) {
  const booked = readDateMs(row && row.bookedAt);
  if (Number.isFinite(booked)) {
    return booked;
  }
  const created = readDateMs(row && row.createdAt);
  return Number.isFinite(created) ? created : 0;
}

function calcAssetBalanceAfter(actionType, amountCents, beforeBalanceCents) {
  const before = Number(beforeBalanceCents) || 0;
  const amount = Number(amountCents) || 0;
  if (actionType === "adjust") {
    return amount;
  }
  if (actionType === "increase") {
    return before + amount;
  }
  if (actionType === "decrease") {
    return before - amount;
  }
  return before;
}

async function rebuildAssetAccountBalanceChain(openid, accountId) {
  const account = await getAssetAccountById(openid, accountId);
  if (!account) {
    return { ok: false, errMsg: "资产账户不存在" };
  }
  const res = await db
    .collection("asset_records")
    .where({ ownerOpenid: openid, accountId: String(account._id) })
    .limit(2000)
    .get();
  const rows = (res.data || []).slice();
  const openMs = readAssetAccountOpenedAtMs(account);
  const nonOpenTimes = rows
    .filter((r) => !isOpeningAssetRecordRow(r))
    .map((r) => assetRecordTimeMs(r))
    .filter((t) => Number.isFinite(t));
  const minNonOpen =
    nonOpenTimes.length > 0 ? Math.min.apply(null, nonOpenTimes) : NaN;
  for (let oi = 0; oi < rows.length; oi += 1) {
    const row = rows[oi];
    if (!isOpeningAssetRecordRow(row)) {
      continue;
    }
    const t0 = assetRecordTimeMs(row);
    if (!Number.isFinite(t0) || t0 >= openMs) {
      continue;
    }
    const canAlignToOpen =
      !Number.isFinite(minNonOpen) || minNonOpen >= openMs;
    if (!canAlignToOpen) {
      continue;
    }
    const fix = new Date(openMs);
    try {
      await db.collection("asset_records").doc(String(row._id)).update({
        data: { bookedAt: fix, updatedAt: db.serverDate() },
      });
      row.bookedAt = fix;
    } catch (e) {
      // ignore
    }
  }
  rows.sort((a, b) => {
    const ta = assetRecordTimeMs(a);
    const tb = assetRecordTimeMs(b);
    if (ta !== tb) {
      return ta - tb;
    }
    const ida = String(a._id || "");
    const idb = String(b._id || "");
    return ida.localeCompare(idb);
  });
  let balance = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const actionType = normalizeAssetRecordAction(row.actionType);
    const amountCents = Number(row.amountCents) || 0;
    const beforeBalanceCents = balance;
    const afterBalanceCents = calcAssetBalanceAfter(
      actionType,
      amountCents,
      beforeBalanceCents
    );
    const needPatch =
      Number(row.beforeBalanceCents) !== beforeBalanceCents ||
      Number(row.afterBalanceCents) !== afterBalanceCents;
    if (needPatch) {
      await db.collection("asset_records").doc(String(row._id)).update({
        data: {
          beforeBalanceCents,
          afterBalanceCents,
          updatedAt: db.serverDate(),
        },
      });
    }
    balance = afterBalanceCents;
  }
  await db.collection("asset_accounts").doc(String(account._id)).update({
    data: {
      balanceCents: balance,
      updatedAt: db.serverDate(),
    },
  });
  return { ok: true, balanceCents: balance };
}

function getBookedAtDateForAssetFromTx(tx) {
  if (!tx) {
    return new Date();
  }
  if (tx.bookedAt != null) {
    const b = new Date(tx.bookedAt);
    if (!Number.isNaN(b.getTime())) {
      return b;
    }
  }
  if (tx.createdAt != null) {
    const c = new Date(tx.createdAt);
    if (!Number.isNaN(c.getTime())) {
      return c;
    }
  }
  return new Date();
}

function formatCentsYuanForLedgerSummary(cents) {
  const n = Number(cents) || 0;
  if (!Number.isInteger(n) || n < 0) {
    return "0.00";
  }
  return (n / 100).toFixed(2);
}

/** 有资产账户 id 时，流水对账户余额的「有符号影响」（分，正=余额应增加、负=应减少） */
function computeSignedSourceAssetEffectCentsFromParts(amountCents, flow, assetAccountId) {
  const aid = assetAccountId == null ? "" : String(assetAccountId).trim();
  if (!aid) {
    return 0;
  }
  const n = Number(amountCents) || 0;
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return 0;
  }
  return flow === "income" ? n : -n;
}

function actionAndAmountForSignedTargetDelta(signedDelta) {
  const d = Number(signedDelta) || 0;
  if (d === 0 || !Number.isInteger(d)) {
    return null;
  }
  if (d > 0) {
    return { actionType: "increase", amountCents: d };
  }
  return { actionType: "decrease", amountCents: -d };
}

async function appendAssetRecordFromLedgerSource(openid, {
  accountId,
  actionType,
  amountCents,
  bookedAt,
  note,
  sourceLedgerId,
  sourceLedgerName,
  sourceLedgerTxId,
  sourceOperation,
  sourceChangeSummary,
}) {
  const access = await getAssetAccountAccess(
    openid,
    String(accountId == null ? "" : accountId).trim()
  );
  if (!access.ok) {
    return { ok: false, errMsg: access.errMsg || "资产账户不存在" };
  }
  if (access.role === "viewer") {
    return { ok: false, errMsg: "只读共享账户不可操作" };
  }
  const ownerOpenid = access.ownerOpenid;
  const acc = access.account;
  if (acc.archived === true) {
    return { ok: false, errMsg: "该资产账户已归档" };
  }
  const n = Math.round(Number(amountCents) || 0);
  const at = normalizeAssetRecordAction(actionType);
  if (!at) {
    return { ok: false, errMsg: "变动类型无效" };
  }
  if (at !== "adjust" && n <= 0) {
    return { ok: false, errMsg: "金额无效" };
  }
  const beforeBalanceCents = Number(acc.balanceCents) || 0;
  const afterBalanceCents = calcAssetBalanceAfter(at, n, beforeBalanceCents);
  const idStr = String(acc._id);
  const bt =
    bookedAt instanceof Date && !Number.isNaN(bookedAt.getTime())
      ? bookedAt
      : new Date();
  const btCheck = assertBookedAtNotBeforeAccountOpen(
    acc,
    bt,
    "该流水对应的资产时间不能早于账户创建时间，请调整记账时间后重试"
  );
  if (!btCheck.ok) {
    return { ok: false, errMsg: btCheck.errMsg };
  }
  const addRes = await db.collection("asset_records").add({
    data: {
      ownerOpenid,
      accountId: idStr,
      actionType: at,
      amountCents: n,
      bookedAt: bt,
      note: normalizeAssetRecordNote(note),
      beforeBalanceCents,
      afterBalanceCents,
      sourceLedgerId: String(sourceLedgerId || "").trim(),
      sourceLedgerName: String(sourceLedgerName || "").trim().slice(0, 64),
      sourceLedgerTxId: String(sourceLedgerTxId || "").trim(),
      sourceOperation: String(sourceOperation || "").trim().slice(0, 32),
      sourceChangeSummary: String(sourceChangeSummary || "").trim().slice(0, 200),
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
  await db.collection("asset_accounts").doc(idStr).update({
    data: { balanceCents: afterBalanceCents, updatedAt: db.serverDate() },
  });
  const rebuilt = await rebuildAssetAccountBalanceChain(ownerOpenid, idStr);
  if (!rebuilt.ok) {
    return { ok: false, errMsg: rebuilt.errMsg || "余额重算失败" };
  }
  await rebuildAssetSnapshots(ownerOpenid);
  return { ok: true, recordId: addRes && addRes._id ? addRes._id : "" };
}

async function applyLedgerCreateAssetLink(openid, ledgerId, txId, linkOpts) {
  const L = await fetchLedgerById(ledgerId);
  const ledgerName = (L && L.name) || "账本";
  const tx = await fetchTransactionById(txId);
  if (!tx) {
    return { ok: false, errMsg: "流水创建后读取失败" };
  }
  const accId = String(tx.assetAccountId || "").trim();
  if (!accId) {
    return { ok: false, errMsg: "缺少资产账户" };
  }
  const n = Number(tx.amountCents) || 0;
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, errMsg: "流水金额无效" };
  }
  const flow = normalizeTxFlow(tx);
  const actionType = flow === "income" ? "increase" : "decrease";
  const userNote = String(tx.note || "").trim();
  const noteVerb =
    linkOpts && linkOpts.noteVerb
      ? String(linkOpts.noteVerb).trim().slice(0, 32)
      : "记一笔";
  const sourceSummary =
    linkOpts && linkOpts.sourceChangeSummary
      ? String(linkOpts.sourceChangeSummary).trim().slice(0, 32)
      : "记一笔";
  const line = `来自账本「${ledgerName}」·${noteVerb}${
    userNote ? ` · ${userNote.length > 40 ? userNote.slice(0, 40) + "…" : userNote}` : ""
  }`;
  const ar = await appendAssetRecordFromLedgerSource(openid, {
    accountId: accId,
    actionType,
    amountCents: n,
    bookedAt: getBookedAtDateForAssetFromTx(tx),
    note: line,
    sourceLedgerId: ledgerId,
    sourceLedgerName: ledgerName,
    sourceLedgerTxId: String(txId).trim(),
    sourceOperation: "ledger_create",
    sourceChangeSummary: sourceSummary,
  });
  if (!ar.ok) {
    return { ok: false, errMsg: ar.errMsg };
  }
  const effect = computeSignedSourceAssetEffectCentsFromParts(n, flow, accId);
  try {
    await db
      .collection("transactions")
      .doc(String(txId).trim())
      .update({
        data: {
          sourceAssetEffectCents: effect,
          primaryAssetRecordId: ar.recordId || "",
          updatedAt: db.serverDate(),
        },
      });
  } catch (e) {
    return { ok: false, errMsg: "回写流水失败" };
  }
  return { ok: true, recordId: ar.recordId };
}

async function applyLedgerDeleteAssetLink(openid, ledgerId, oldTx) {
  const L = await fetchLedgerById(ledgerId);
  const ledgerName = (L && L.name) || "账本";
  const accId = String(oldTx.assetAccountId || "").trim();
  const eff = Number(oldTx.sourceAssetEffectCents);
  const hasEff = Number.isInteger(eff) && eff !== 0;
  if (!hasEff || !accId) {
    return { ok: true };
  }
  const rev = actionAndAmountForSignedTargetDelta(-eff);
  if (!rev) {
    return { ok: true };
  }
  const userNote = String(oldTx.note || "").trim();
  const line = `来自账本「${ledgerName}」·删除流水${
    userNote ? ` · ${userNote.length > 40 ? userNote.slice(0, 40) + "…" : userNote}` : ""
  }`;
  const r = await appendAssetRecordFromLedgerSource(openid, {
    accountId: accId,
    actionType: rev.actionType,
    amountCents: rev.amountCents,
    bookedAt: new Date(),
    note: line,
    sourceLedgerId: ledgerId,
    sourceLedgerName: ledgerName,
    sourceLedgerTxId: String(oldTx._id || "").trim(),
    sourceOperation: "ledger_delete",
    sourceChangeSummary: "删除流水",
  });
  return { ok: r.ok, errMsg: r.errMsg };
}

async function applyLedgerUpdateAssetSideEffects(
  openid,
  ledgerId,
  txId,
  oldTx,
  merged
) {
  const L = await fetchLedgerById(ledgerId);
  const ledgerName = (L && L.name) || "账本";
  const newAmount = Math.round(Number(merged.amountCents) || 0);
  const newFlow = merged.flow === "income" ? "income" : "expense";
  const newAccId = String(merged.assetAccountId || "").trim();
  const oldAccId = String(oldTx.assetAccountId || "").trim();
  const oldN = Math.round(Number(oldTx.amountCents) || 0);
  const oldFlow = normalizeTxFlow(oldTx);
  const oldEffectRaw = oldTx.sourceAssetEffectCents;
  const oldEffect = Number.isInteger(Number(oldEffectRaw)) ? Number(oldEffectRaw) : 0;
  const newEffect = computeSignedSourceAssetEffectCentsFromParts(
    newAmount,
    newFlow,
    newAccId
  );
  const flowText = (f) => (f === "income" ? "收入" : "支出");
  const appendOne = async (accId, actionType, amt, summary, longNote) => {
    return appendAssetRecordFromLedgerSource(openid, {
      accountId: accId,
      actionType,
      amountCents: amt,
      bookedAt: new Date(),
      note: longNote,
      sourceLedgerId: ledgerId,
      sourceLedgerName: ledgerName,
      sourceLedgerTxId: String(txId).trim(),
      sourceOperation: "ledger_update",
      sourceChangeSummary: summary,
    });
  };
  if (!oldAccId && !newAccId) {
    return { ok: true, txDataPatch: {} };
  }
  if (!oldAccId && newAccId) {
    if (newEffect === 0) {
      return {
        ok: true,
        txDataPatch: {
          sourceAssetEffectCents: _.remove(),
          primaryAssetRecordId: _.remove(),
        },
      };
    }
    const a = newEffect > 0 ? "increase" : "decrease";
    const line = `来自账本「${ledgerName}」·编辑流水（开始关联本账户）·${flowText(
      newFlow
    )} ¥${formatCentsYuanForLedgerSummary(newAmount)}`;
    const r = await appendOne(newAccId, a, Math.abs(newEffect), "编辑：首次关联", line);
    if (!r.ok) {
      return { ok: false, errMsg: r.errMsg, txDataPatch: {} };
    }
    return {
      ok: true,
      txDataPatch: { sourceAssetEffectCents: newEffect, primaryAssetRecordId: r.recordId },
    };
  }
  if (oldAccId && !newAccId) {
    if (oldEffect === 0) {
      return {
        ok: true,
        txDataPatch: {
          sourceAssetEffectCents: _.remove(),
          primaryAssetRecordId: _.remove(),
        },
      };
    }
    const rev = actionAndAmountForSignedTargetDelta(-oldEffect);
    if (!rev) {
      return {
        ok: true,
        txDataPatch: {
          sourceAssetEffectCents: _.remove(),
          primaryAssetRecordId: _.remove(),
        },
      };
    }
    const line = `来自账本「${ledgerName}」·编辑流水（已解除资产关联）·原为${flowText(
      oldFlow
    )} ¥${formatCentsYuanForLedgerSummary(oldN)}`;
    const r = await appendOne(
      oldAccId,
      rev.actionType,
      rev.amountCents,
      "编辑：解除关联",
      line
    );
    if (!r.ok) {
      return { ok: false, errMsg: r.errMsg, txDataPatch: {} };
    }
    return {
      ok: true,
      txDataPatch: {
        sourceAssetEffectCents: _.remove(),
        primaryAssetRecordId: _.remove(),
      },
    };
  }
  if (oldAccId && newAccId && oldAccId !== newAccId) {
    if (oldEffect !== 0) {
      const r1 = actionAndAmountForSignedTargetDelta(-oldEffect);
      if (r1) {
        const line1 = `来自账本「${ledgerName}」·编辑流水（更换资产账户-转出方）·${flowText(
          oldFlow
        )} ¥${formatCentsYuanForLedgerSummary(oldN)}`;
        const x = await appendOne(
          oldAccId,
          r1.actionType,
          r1.amountCents,
          "编辑：更换账户(一)",
          line1
        );
        if (!x.ok) {
          return { ok: false, errMsg: x.errMsg, txDataPatch: {} };
        }
      }
    }
    if (newEffect === 0) {
      return {
        ok: true,
        txDataPatch: {
          sourceAssetEffectCents: _.remove(),
          primaryAssetRecordId: _.remove(),
        },
      };
    }
    const a2 = newEffect > 0 ? "increase" : "decrease";
    const line2 = `来自账本「${ledgerName}」·编辑流水（更换资产账户-转入方）·${flowText(
      newFlow
    )} ¥${formatCentsYuanForLedgerSummary(newAmount)}`;
    const r2 = await appendOne(
      newAccId,
      a2,
      Math.abs(newEffect),
      "编辑：更换账户(二)",
      line2
    );
    if (!r2.ok) {
      return { ok: false, errMsg: r2.errMsg, txDataPatch: {} };
    }
    return {
      ok: true,
      txDataPatch: { sourceAssetEffectCents: newEffect, primaryAssetRecordId: r2.recordId },
    };
  }
  const delta = newEffect - oldEffect;
  if (delta === 0) {
    return { ok: true, txDataPatch: { sourceAssetEffectCents: newEffect } };
  }
  const dAct = actionAndAmountForSignedTargetDelta(delta);
  if (!dAct) {
    return { ok: true, txDataPatch: { sourceAssetEffectCents: newEffect } };
  }
  const ch = `金额 ¥${formatCentsYuanForLedgerSummary(
    oldN
  )}（${flowText(oldFlow)}）→ ¥${formatCentsYuanForLedgerSummary(
    newAmount
  )}（${flowText(newFlow)}）`;
  const line = `来自账本「${ledgerName}」·编辑流水 · ${ch}`;
  const r = await appendOne(
    oldAccId,
    dAct.actionType,
    dAct.amountCents,
    "编辑：调整",
    line
  );
  if (!r.ok) {
    return { ok: false, errMsg: r.errMsg, txDataPatch: {} };
  }
  return { ok: true, txDataPatch: { sourceAssetEffectCents: newEffect } };
}

function assetSnapshotDocId(openid, monthKey) {
  return `${openid}_${monthKey}`;
}

function monthDateStart(monthKey) {
  const y = Number(String(monthKey || "").slice(0, 4));
  const m = Number(String(monthKey || "").slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return null;
  }
  return new Date(y, m - 1, 1, 0, 0, 0, 0);
}

async function rebuildAssetSnapshots(openid) {
  const accRes = await db
    .collection("asset_accounts")
    .where({ ownerOpenid: openid })
    .limit(500)
    .get();
  const accounts = accRes.data || [];
  const accountMeta = {};
  for (let i = 0; i < accounts.length; i += 1) {
    const a = accounts[i];
    accountMeta[a._id] = {
      kind: a.kind === "liability" ? "liability" : "asset",
      includeInNetWorth: a.includeInNetWorth !== false,
      currentBalanceCents: Number(a.balanceCents) || 0,
    };
  }

  const recRes = await db
    .collection("asset_records")
    .where({ ownerOpenid: openid })
    .limit(2000)
    .get();
  const rows = (recRes.data || []).slice();
  rows.sort((a, b) => {
    const ta = assetRecordTimeMs(a);
    const tb = assetRecordTimeMs(b);
    if (ta !== tb) {
      return ta - tb;
    }
    const ida = String(a._id || "");
    const idb = String(b._id || "");
    return ida.localeCompare(idb);
  });

  let monthPoints = [];
  if (!rows.length) {
    let totalAssets = 0;
    let totalLiabilities = 0;
    const ids = Object.keys(accountMeta);
    for (let i = 0; i < ids.length; i += 1) {
      const meta = accountMeta[ids[i]];
      if (!meta || !meta.includeInNetWorth) {
        continue;
      }
      const amt = Number(meta.currentBalanceCents) || 0;
      if (meta.kind === "liability") {
        totalLiabilities += amt;
      } else {
        totalAssets += amt;
      }
    }
    const nowKey = monthKeyByDate(new Date());
    monthPoints.push({
      month: nowKey,
      totalAssetsCents: totalAssets,
      totalLiabilitiesCents: totalLiabilities,
      netWorthCents: totalAssets - totalLiabilities,
    });
  } else {
    const stateByAccount = {};
    const firstMs = assetRecordTimeMs(rows[0]) || Date.now();
    const first = new Date(firstMs);
    const now = new Date();
    const walk = new Date(first.getFullYear(), first.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const monthKeys = [];
    while (walk.getTime() <= end.getTime()) {
      monthKeys.push(monthKeyByDate(walk));
      walk.setMonth(walk.getMonth() + 1);
    }
    const monthEndMsByKey = {};
    for (let i = 0; i < monthKeys.length; i += 1) {
      const key = monthKeys[i];
      const y = Number(key.slice(0, 4));
      const m = Number(key.slice(5, 7));
      monthEndMsByKey[key] = new Date(y, m, 0, 23, 59, 59, 999).getTime();
    }
    let idx = 0;
    for (let i = 0; i < monthKeys.length; i += 1) {
      const mk = monthKeys[i];
      const endMs = monthEndMsByKey[mk];
      while (idx < rows.length) {
        const row = rows[idx];
        const t = assetRecordTimeMs(row);
        if (!Number.isFinite(t) || t > endMs) {
          break;
        }
        stateByAccount[row.accountId] = Number(row.afterBalanceCents) || 0;
        idx += 1;
      }
      let totalAssets = 0;
      let totalLiabilities = 0;
      const ids = Object.keys(stateByAccount);
      for (let j = 0; j < ids.length; j += 1) {
        const aid = ids[j];
        const meta = accountMeta[aid];
        if (!meta || !meta.includeInNetWorth) {
          continue;
        }
        const amt = Number(stateByAccount[aid]) || 0;
        if (meta.kind === "liability") {
          totalLiabilities += amt;
        } else {
          totalAssets += amt;
        }
      }
      monthPoints.push({
        month: mk,
        totalAssetsCents: totalAssets,
        totalLiabilitiesCents: totalLiabilities,
        netWorthCents: totalAssets - totalLiabilities,
      });
    }
  }

  if (monthPoints.length > ASSET_SNAPSHOT_PERSIST_MAX) {
    monthPoints = monthPoints.slice(-ASSET_SNAPSHOT_PERSIST_MAX);
  }

  const snapColl = db.collection("asset_snapshots");
  await removeDocumentsWhere("asset_snapshots", { ownerOpenid: openid }, 200);
  for (let w = 0; w < monthPoints.length; w += ASSET_SNAPSHOT_WRITE_BATCH) {
    const batch = monthPoints.slice(w, w + ASSET_SNAPSHOT_WRITE_BATCH);
    await Promise.all(
      batch.map((point) => {
        const month = point.month;
        return snapColl.doc(assetSnapshotDocId(openid, month)).set({
          data: {
            ownerOpenid: openid,
            month,
            monthStartAt: monthDateStart(month),
            totalAssetsCents: point.totalAssetsCents,
            totalLiabilitiesCents: point.totalLiabilitiesCents,
            netWorthCents: point.netWorthCents,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        });
      })
    );
  }
  return { ok: true, points: monthPoints };
}

async function createAssetAccount(openid, event) {
  const name = normalizeAssetAccountName(event.name);
  if (!name) {
    return { success: false, errMsg: "请输入账户名称" };
  }
  const kind = normalizeAssetAccountKind(event.kind);
  if (!kind) {
    return { success: false, errMsg: "账户类型无效" };
  }
  const type = normalizeAssetAccountType(
    event.accountType != null ? event.accountType : event.type
  );
  if (!type) {
    return { success: false, errMsg: "账户分类无效" };
  }
  const balanceCents = readAssetBalanceCents(event.balanceCents);
  if (!Number.isFinite(balanceCents)) {
    return { success: false, errMsg: "账户余额无效" };
  }
  const sortOrder = readAssetSortOrder(event.sortOrder);
  const includeInNetWorth = event.includeInNetWorth !== false;
  const remark = normalizeAssetAccountRemark(event.remark);
  const openedAtMs = Date.now();
  const addRes = await db.collection("asset_accounts").add({
    data: {
      ownerOpenid: openid,
      name,
      kind,
      type,
      balanceCents,
      currency: "CNY",
      includeInNetWorth,
      visibility: "private",
      archived: false,
      sortOrder,
      remark,
      openedAtMs,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
  const newAccountId = String(addRes._id);
  // 账户文档上的期初 balanceCents 必须能由 asset_records 重放还原；`rebuildAssetAccountBalanceChain`
  // 从零累加记录，否则首次记变动后会覆盖余额，丢失开户时填写的非零期初（见本函数上方 balance 重算约定）。
  if (balanceCents !== 0) {
    const openingBookedAt = new Date(openedAtMs);
    await db.collection("asset_records").add({
      data: {
        ownerOpenid: openid,
        accountId: newAccountId,
        actionType: "adjust",
        amountCents: balanceCents,
        bookedAt: openingBookedAt,
        note: normalizeAssetRecordNote("期初余额（开户）"),
        beforeBalanceCents: 0,
        afterBalanceCents: balanceCents,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    await rebuildAssetAccountBalanceChain(openid, newAccountId);
    await rebuildAssetSnapshots(openid);
  }
  return { success: true, accountId: addRes._id };
}

async function listAssetAccounts(openid, event) {
  const ev = event || {};
  const scope = String(ev.scope || "personal").trim() === "shared" ? "shared" : "personal";
  const archivedOnly = ev.archivedOnly === true;
  const includeAll = !archivedOnly && !!ev.includeArchived;
  if (scope === "shared") {
    const shareRes = await db
      .collection("asset_account_shares")
      .where({ memberOpenid: openid, status: "active" })
      .limit(500)
      .get();
    const shareRows = shareRes.data || [];
    const accountIds = [];
    const roleByAccountId = {};
    for (let i = 0; i < shareRows.length; i += 1) {
      const row = shareRows[i];
      const aid = String(row.accountId || "").trim();
      if (!aid) continue;
      if (!roleByAccountId[aid]) {
        accountIds.push(aid);
      }
      roleByAccountId[aid] = "viewer";
    }
    if (!accountIds.length) {
      return { success: true, list: [], grouped: [] };
    }
    let where = { _id: _.in(accountIds) };
    if (archivedOnly) {
      where.archived = true;
    } else if (!includeAll) {
      where.archived = _.neq(true);
    }
    const res = await db.collection("asset_accounts").where(where).limit(500).get();
    const rows = await attachOwnerProfilesToAssetRows(
      sortAssetAccountRowsByBalanceDesc(res.data || []).map((row) => ({
        ...row,
        shareRole: roleByAccountId[String(row._id)] || "viewer",
      }))
    );
    const grouped = buildGroupedSharedAssetAccounts(rows);
    return { success: true, list: rows, grouped };
  }
  const where = { ownerOpenid: openid };
  if (archivedOnly) {
    where.archived = true;
  } else if (!includeAll) {
    where.archived = _.neq(true);
  }
  const res = await db
    .collection("asset_accounts")
    .where(where)
    .limit(200)
    .get();
  const rows = await attachOutboundShareMemberCounts(
    openid,
    sortAssetAccountRowsByBalanceDesc(res.data || [])
  );
  return { success: true, list: rows };
}

async function getAssetAccount(openid, event) {
  const access = await getAssetAccountAccess(openid, event.accountId);
  if (!access.ok) {
    return { success: false, errMsg: access.errMsg || "资产账户不存在" };
  }
  let account = access.account;
  if (access.role !== "owner") {
    const enriched = await attachOwnerProfilesToAssetRows([
      { ...account, shareRole: access.role },
    ]);
    account = enriched[0] || account;
  }
  return {
    success: true,
    account,
    role: access.role,
    ownerOpenid: access.ownerOpenid,
  };
}

async function updateAssetAccount(openid, event) {
  const access = await getAssetAccountAccess(openid, event.accountId);
  if (!access.ok) {
    return { success: false, errMsg: access.errMsg || "资产账户不存在" };
  }
  if (access.role !== "owner") {
    return { success: false, errMsg: "无权编辑该资产账户" };
  }
  const account = access.account;
  const patch = {};
  if (event.name != null) {
    const name = normalizeAssetAccountName(event.name);
    if (!name) {
      return { success: false, errMsg: "请输入账户名称" };
    }
    patch.name = name;
  }
  if (event.kind != null) {
    const kind = normalizeAssetAccountKind(event.kind);
    if (!kind) {
      return { success: false, errMsg: "账户类型无效" };
    }
    patch.kind = kind;
  }
  if (event.accountType != null || event.type != null) {
    const type = normalizeAssetAccountType(
      event.accountType != null ? event.accountType : event.type
    );
    if (!type) {
      return { success: false, errMsg: "账户分类无效" };
    }
    patch.type = type;
  }
  // 编辑账户不改余额；余额由 asset_records 变动链维护，新建见 createAssetAccount
  if (event.sortOrder != null) {
    patch.sortOrder = readAssetSortOrder(event.sortOrder);
  }
  if (event.includeInNetWorth != null) {
    patch.includeInNetWorth = !!event.includeInNetWorth;
  }
  if (event.remark != null) {
    patch.remark = normalizeAssetAccountRemark(event.remark);
  }
  if (Object.keys(patch).length === 0) {
    return { success: false, errMsg: "没有可更新内容" };
  }
  patch.updatedAt = db.serverDate();
  await db.collection("asset_accounts").doc(String(account._id)).update({ data: patch });
  return { success: true };
}

async function archiveAssetAccount(openid, event) {
  const access = await getAssetAccountAccess(openid, event.accountId);
  if (!access.ok) {
    return { success: false, errMsg: access.errMsg || "资产账户不存在" };
  }
  if (access.role !== "owner") {
    return { success: false, errMsg: "无权操作该资产账户" };
  }
  const account = access.account;
  const archived = event.archived !== false;
  await db.collection("asset_accounts").doc(String(account._id)).update({
    data: {
      archived,
      updatedAt: db.serverDate(),
    },
  });
  return { success: true };
}

async function deleteAssetAccount(openid, event) {
  const access = await getAssetAccountAccess(openid, event.accountId);
  if (!access.ok) {
    return { success: false, errMsg: access.errMsg || "资产账户不存在" };
  }
  if (access.role !== "owner") {
    return { success: false, errMsg: "仅户主可删除账户" };
  }
  const account = access.account;
  const countRes = await db
    .collection("asset_records")
    .where({ ownerOpenid: openid, accountId: String(account._id) })
    .count();
  if ((countRes && countRes.total) > 0) {
    return {
      success: false,
      errMsg: "该账户已有任意变动记录（含期初、转账、或账本关联），无法删除。请使用「归档」隐藏账户。",
    };
  }
  await db.collection("asset_accounts").doc(String(account._id)).remove();
  return { success: true };
}

/** 快照按 `month` 升序的最后两个月，相对净资产环比（小数百分数，可为负）；快照不足或未定义时返回 null */
function computeNetWorthMonthOverPrevMonthPctFromSnapshotRows(rawRows) {
  const rows = (rawRows || [])
    .filter((r) => r && String(r.month || "").trim())
    .sort((a, b) => String(a.month || "").localeCompare(String(b.month || "")));
  if (rows.length < 2) {
    return null;
  }
  const prev = rows[rows.length - 2];
  const cur = rows[rows.length - 1];
  const np = Number(prev.netWorthCents);
  const nc = Number(cur.netWorthCents);
  if (!Number.isFinite(np) || !Number.isFinite(nc)) {
    return null;
  }
  const absPrev = Math.abs(np);
  if (absPrev < 1e-9) {
    return null;
  }
  const ratio = ((nc - np) / absPrev) * 100;
  return Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null;
}

async function getAssetDashboard(openid, event) {
  const ev = event || {};
  const rawScope = String(ev.scope || "all").trim();
  const scope = rawScope === "shared" || rawScope === "personal" ? rawScope : "all";
  let rows = [];
  const loadSharedRows = async () => {
    const shareRes = await db
      .collection("asset_account_shares")
      .where({ memberOpenid: openid, status: "active" })
      .limit(500)
      .get();
    let sharedRows = [];
    const shareRows = shareRes.data || [];
    const roleByAccountId = {};
    shareRows.forEach((row) => {
      const accountId = String(row.accountId || "").trim();
      if (!accountId) return;
      roleByAccountId[accountId] = String(row.role || "").trim() || "viewer";
    });
    const accountIds = [...new Set(shareRows.map((r) => String(r.accountId || "").trim()).filter(Boolean))];
    if (accountIds.length) {
      const accRes = await db
        .collection("asset_accounts")
        .where({ _id: _.in(accountIds), archived: _.neq(true) })
        .limit(500)
        .get();
      sharedRows = await attachOwnerProfilesToAssetRows(
        sortAssetAccountRowsByBalanceDesc(accRes.data || []).map((row) => ({
          ...row,
          shareRole: roleByAccountId[String(row._id)] || "viewer",
        }))
      );
    }
    return sharedRows;
  };
  const loadPersonalRows = async () => {
    const res = await db
      .collection("asset_accounts")
      .where({ ownerOpenid: openid, archived: _.neq(true) })
      .limit(200)
      .get();
    return sortAssetAccountRowsByBalanceDesc(res.data || []);
  };
  if (scope === "shared") {
    rows = await loadSharedRows();
  } else if (scope === "personal") {
    rows = await loadPersonalRows();
  } else {
    const [personalRows, sharedRows] = await Promise.all([loadPersonalRows(), loadSharedRows()]);
    rows = personalRows.concat(sharedRows);
  }
  if (scope !== "shared") {
    rows = await attachOutboundShareMemberCounts(openid, rows);
  }
  let totalAssetsCents = 0;
  let totalLiabilitiesCents = 0;
  const assetTypeMap = {};
  const liabilityTypeMap = {};
  const assetAccounts = [];
  const liabilityAccounts = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const amount = Number(row.balanceCents) || 0;
    const type = normalizeAssetAccountType(row.type) || "other";
    const countsTowardNetWorth = row.includeInNetWorth !== false;
    if (row.kind === "liability") {
      liabilityAccounts.push(row);
      if (countsTowardNetWorth) {
        totalLiabilitiesCents += amount;
        liabilityTypeMap[type] = (liabilityTypeMap[type] || 0) + amount;
      }
    } else {
      assetAccounts.push(row);
      if (countsTowardNetWorth) {
        totalAssetsCents += amount;
        assetTypeMap[type] = (assetTypeMap[type] || 0) + amount;
      }
    }
  }
  const netWorthCents = totalAssetsCents - totalLiabilitiesCents;
  const toGroups = (typeMap, total) =>
    Object.keys(typeMap)
      .map((k) => {
        const amount = Number(typeMap[k]) || 0;
        const percent = total > 0 ? Math.round((amount * 1000) / total) / 10 : 0;
        return { key: k, label: k, amountCents: amount, percent };
      })
      .sort((a, b) => b.amountCents - a.amountCents);
  let monthOverPrevMonthNetWorthPct = null;
  try {
    const snapRes = await db
      .collection("asset_snapshots")
      .where({ ownerOpenid: openid })
      .limit(200)
      .get();
    monthOverPrevMonthNetWorthPct = computeNetWorthMonthOverPrevMonthPctFromSnapshotRows(snapRes.data || []);
  } catch (_) {
    monthOverPrevMonthNetWorthPct = null;
  }
  return {
    success: true,
    scope,
    totalAssetsCents,
    totalLiabilitiesCents,
    netWorthCents,
    monthOverPrevMonthNetWorthPct,
    assetAccounts,
    liabilityAccounts,
    assetTypeGroups: toGroups(assetTypeMap, totalAssetsCents),
    liabilityTypeGroups: toGroups(liabilityTypeMap, totalLiabilitiesCents),
  };
}

async function listAssetRecords(openid, event) {
  const ev = event || {};
  const where = {};
  const accountId = String(ev.accountId == null ? "" : ev.accountId).trim();
  const rawScope = String(ev.scope || "personal").trim();
  const scope = rawScope === "all" || rawScope === "shared" ? rawScope : "personal";
  let accessibleAccountIds = [];
  if (accountId) {
    const access = await getAssetAccountAccess(openid, accountId);
    if (!access.ok) {
      return { success: false, errMsg: access.errMsg || "无权访问该资产账户" };
    }
    where.ownerOpenid = access.ownerOpenid;
    where.accountId = accountId;
  } else {
    const ownAccountIds = [];
    if (scope !== "shared") {
      const ownRes = await db
        .collection("asset_accounts")
        .where({ ownerOpenid: openid })
        .field({ _id: true })
        .limit(500)
        .get();
      (ownRes.data || []).forEach((row) => {
        const aid = String(row._id || "").trim();
        if (aid) ownAccountIds.push(aid);
      });
    }
    const sharedAccountIds = [];
    if (scope !== "personal") {
      const sharedRes = await db
        .collection("asset_account_shares")
        .where({ memberOpenid: openid, status: "active" })
        .field({ accountId: true })
        .limit(500)
        .get();
      (sharedRes.data || []).forEach((row) => {
        const aid = String(row.accountId || "").trim();
        if (aid) sharedAccountIds.push(aid);
      });
    }
    accessibleAccountIds = [...new Set(ownAccountIds.concat(sharedAccountIds))];
    if (!accessibleAccountIds.length) {
      return { success: true, list: [] };
    }
    where.accountId = _.in(accessibleAccountIds);
  }
  const res = await db
    .collection("asset_records")
    .where(where)
    .limit(500)
    .get();
  const rows = (res.data || []).slice();
  const accountIdSet = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const mainId = String(r.accountId || "").trim();
    if (mainId) accountIdSet.add(mainId);
    const cpId = String(r.counterpartyAccountId || "").trim();
    if (cpId) accountIdSet.add(cpId);
  }
  const accountIds = [...accountIdSet];
  const accountNameMap = {};
  if (accountIds.length) {
    let accountIdsForName = accountIds;
    if (!accountId && accessibleAccountIds.length) {
      const allowedSet = new Set(accessibleAccountIds);
      accountIdsForName = accountIds.filter((id) => allowedSet.has(id));
    }
    if (!accountIdsForName.length) {
      accountIdsForName = accountIds.filter((id) => id === accountId);
    }
    const accRes = await db
      .collection("asset_accounts")
      .where({ _id: _.in(accountIdsForName) })
      .field({ _id: true, name: true })
      .limit(500)
      .get();
    const accRows = accRes.data || [];
    for (let i = 0; i < accRows.length; i += 1) {
      const row = accRows[i];
      accountNameMap[String(row._id)] = String(row.name || "").trim();
    }
  }
  rows.sort((a, b) => {
    const ta = readDateMs(a.bookedAt) || readDateMs(a.createdAt);
    const tb = readDateMs(b.bookedAt) || readDateMs(b.createdAt);
    return tb - ta;
  });
  const list = rows.map((row) => ({
    ...row,
    accountName: row.accountId
      ? accountNameMap[String(row.accountId)] || ""
      : "",
    counterpartyAccountName: row.counterpartyAccountId
      ? accountNameMap[String(row.counterpartyAccountId)] || ""
      : "",
  }));
  return { success: true, list };
}

async function createAssetRecord(openid, event) {
  const accountId = String(event.accountId == null ? "" : event.accountId).trim();
  if (!accountId) {
    return { success: false, errMsg: "缺少账户" };
  }
  const access = await getAssetAccountAccess(openid, accountId);
  if (!access.ok) {
    return { success: false, errMsg: access.errMsg || "资产账户不存在" };
  }
  if (access.role !== "owner") {
    return { success: false, errMsg: "共享账户不可记变动" };
  }
  const ownerOpenid = access.ownerOpenid;
  const account = access.account;
  if (account.archived) {
    return { success: false, errMsg: "归档账户不可记变动" };
  }
  const actionType = normalizeAssetRecordAction(event.actionType);
  if (!actionType) {
    return { success: false, errMsg: "变动类型无效" };
  }
  const amountCents = readAssetBalanceCents(event.amountCents);
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    return { success: false, errMsg: "变动金额无效" };
  }
  if (actionType !== "adjust" && amountCents <= 0) {
    return { success: false, errMsg: "请输入大于 0 的金额" };
  }
  const bookedAt = parseAssetRecordBookedAt(event);
  if (!bookedAt) {
    return { success: false, errMsg: "记账时间不合法" };
  }
  const tOpen0 = assertBookedAtNotBeforeAccountOpen(
    account,
    bookedAt,
    "记账时间不能早于账户创建时间"
  );
  if (!tOpen0.ok) {
    return { success: false, errMsg: tOpen0.errMsg };
  }
  const note = normalizeAssetRecordNote(event.note);
  const syncReq = parseAssetLedgerSyncRequest(event, actionType);
  if (syncReq.errMsg) {
    return { success: false, errMsg: syncReq.errMsg };
  }
  const beforeBalanceCents = Number(account.balanceCents) || 0;
  let afterBalanceCents = beforeBalanceCents;
  if (actionType === "adjust") {
    afterBalanceCents = amountCents;
  } else if (actionType === "increase") {
    afterBalanceCents = beforeBalanceCents + amountCents;
  } else if (actionType === "decrease") {
    afterBalanceCents = beforeBalanceCents - amountCents;
  }
  const addRes = await db.collection("asset_records").add({
    data: {
      ownerOpenid,
      accountId: String(account._id),
      actionType,
      amountCents,
      bookedAt,
      note,
      beforeBalanceCents,
      afterBalanceCents,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
  await db.collection("asset_accounts").doc(String(account._id)).update({
    data: { balanceCents: afterBalanceCents, updatedAt: db.serverDate() },
  });
  const rebuilt = await rebuildAssetAccountBalanceChain(ownerOpenid, String(account._id));
  if (!rebuilt.ok) {
    return { success: false, errMsg: rebuilt.errMsg || "余额重算失败" };
  }
  if (syncReq.enabled) {
    const syncIns = await insertLedgerTransaction(openid, syncReq.ledgerId, {
      amountCents,
      flow: syncReq.flow,
      category: syncReq.category,
      note,
      bookedAt,
    });
    if (!syncIns.ok) {
      await db.collection("asset_records").doc(String(addRes._id)).remove();
      await rebuildAssetAccountBalanceChain(ownerOpenid, String(account._id));
      await rebuildAssetSnapshots(ownerOpenid);
      return { success: false, errMsg: `同步账本失败：${syncIns.errMsg || "请稍后重试"}` };
    }
    await db.collection("asset_records").doc(String(addRes._id)).update({
      data: {
        syncLedgerId: syncReq.ledgerId,
        syncCategory: syncReq.category,
        syncFlow: syncReq.flow,
        syncTxId: syncIns.txId,
        updatedAt: db.serverDate(),
      },
    });
  }
  await rebuildAssetSnapshots(ownerOpenid);
  return { success: true, recordId: addRes._id, latestBalanceCents: rebuilt.balanceCents };
}

async function getAssetRecord(openid, event) {
  const id = String(event.recordId == null ? "" : event.recordId).trim();
  if (!id) {
    return { success: false, errMsg: "缺少记录" };
  }
  const res = await db.collection("asset_records").where({ _id: id }).limit(1).get();
  const row = (res.data && res.data[0]) || null;
  if (!row) {
    return { success: false, errMsg: "记录不存在" };
  }
  const access = await getAssetAccountAccess(openid, row.accountId);
  if (!access.ok) {
    return { success: false, errMsg: "记录不存在或无权访问" };
  }
  return { success: true, record: row };
}

async function updateAssetRecord(_openid, _event) {
  return { success: false, errMsg: "历史变动仅支持查看，请通过新的变动/调整或转账修正" };
}

async function deleteAssetRecord(_openid, _event) {
  return { success: false, errMsg: "历史变动仅支持查看，请通过新的变动/调整或转账修正" };
}

async function createAssetTransfer(openid, event) {
  const fromAccountId = String(event.fromAccountId == null ? "" : event.fromAccountId).trim();
  const toAccountId = String(event.toAccountId == null ? "" : event.toAccountId).trim();
  if (!fromAccountId || !toAccountId) {
    return { success: false, errMsg: "请选择转出和转入账户" };
  }
  if (fromAccountId === toAccountId) {
    return { success: false, errMsg: "转入转出账户不能相同" };
  }
  const amountCents = readAssetBalanceCents(event.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { success: false, errMsg: "请输入大于 0 的转账金额" };
  }
  const bookedAt = parseAssetRecordBookedAt(event);
  if (!bookedAt) {
    return { success: false, errMsg: "记账时间不合法" };
  }
  const fromAccess = await getAssetAccountAccess(openid, fromAccountId);
  const toAccess = await getAssetAccountAccess(openid, toAccountId);
  if (!fromAccess.ok || !toAccess.ok) {
    return { success: false, errMsg: "账户不存在或无权访问" };
  }
  if (fromAccess.role !== "owner" || toAccess.role !== "owner") {
    return { success: false, errMsg: "共享账户不可转账" };
  }
  const fromAccount = fromAccess.account;
  const toAccount = toAccess.account;
  const ownerOpenid = String(fromAccount.ownerOpenid || "");
  if (!ownerOpenid || ownerOpenid !== String(toAccount.ownerOpenid || "")) {
    return { success: false, errMsg: "仅支持同一户主下账户转账" };
  }
  if (fromAccount.archived || toAccount.archived) {
    return { success: false, errMsg: "归档账户不可转账" };
  }
  const tFrom = assertBookedAtNotBeforeAccountOpen(
    fromAccount,
    bookedAt,
    "转账时间不能早于「转出」账户的创建时间"
  );
  if (!tFrom.ok) {
    return { success: false, errMsg: tFrom.errMsg };
  }
  const tTo = assertBookedAtNotBeforeAccountOpen(
    toAccount,
    bookedAt,
    "转账时间不能早于「转入」账户的创建时间"
  );
  if (!tTo.ok) {
    return { success: false, errMsg: tTo.errMsg };
  }
  const transferPairId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const note = normalizeAssetRecordNote(event.note);
  let fromAfter = 0;
  let toAfter = 0;
  try {
    await db.runTransaction(async (transaction) => {
      const fromDoc = await transaction
        .collection("asset_accounts")
        .doc(String(fromAccount._id))
        .get();
      const toDoc = await transaction
        .collection("asset_accounts")
        .doc(String(toAccount._id))
        .get();
      const fromRow = fromDoc && fromDoc.data;
      const toRow = toDoc && toDoc.data;
      const txFromBefore = Number((fromRow && fromRow.balanceCents) || 0);
      const txToBefore = Number((toRow && toRow.balanceCents) || 0);
      if (txFromBefore < amountCents) {
        throw new Error("转出账户余额不足");
      }
      fromAfter = txFromBefore - amountCents;
      toAfter = txToBefore + amountCents;
      await transaction.collection("asset_records").add({
        data: {
          ownerOpenid,
          accountId: String(fromAccount._id),
          actionType: "decrease",
          amountCents,
          bookedAt,
          note: note ? `[转账转出] ${note}`.slice(0, 200) : "[转账转出]",
          beforeBalanceCents: txFromBefore,
          afterBalanceCents: fromAfter,
          transferPairId,
          counterpartyAccountId: String(toAccount._id),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
      await transaction.collection("asset_records").add({
        data: {
          ownerOpenid,
          accountId: String(toAccount._id),
          actionType: "increase",
          amountCents,
          bookedAt,
          note: note ? `[转账转入] ${note}`.slice(0, 200) : "[转账转入]",
          beforeBalanceCents: txToBefore,
          afterBalanceCents: toAfter,
          transferPairId,
          counterpartyAccountId: String(fromAccount._id),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
      await transaction.collection("asset_accounts").doc(String(fromAccount._id)).update({
        data: { balanceCents: fromAfter, updatedAt: db.serverDate() },
      });
      await transaction.collection("asset_accounts").doc(String(toAccount._id)).update({
        data: { balanceCents: toAfter, updatedAt: db.serverDate() },
      });
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "转账失败";
    return { success: false, errMsg: msg };
  }

  // 转账可能是补录历史日期，需重算两边余额链确保一致。
  const rebuiltFrom = await rebuildAssetAccountBalanceChain(ownerOpenid, String(fromAccount._id));
  if (!rebuiltFrom.ok) {
    return { success: false, errMsg: rebuiltFrom.errMsg || "转账后重算失败" };
  }
  const rebuiltTo = await rebuildAssetAccountBalanceChain(ownerOpenid, String(toAccount._id));
  if (!rebuiltTo.ok) {
    return { success: false, errMsg: rebuiltTo.errMsg || "转账后重算失败" };
  }
  await rebuildAssetSnapshots(ownerOpenid);
  if (rebuiltFrom.balanceCents < 0) {
    return { success: false, errMsg: "转出账户余额不足" };
  }
  return {
    success: true,
    transferPairId,
    fromBalanceCents: rebuiltFrom.balanceCents,
    toBalanceCents: rebuiltTo.balanceCents,
  };
}

function monthKeyByDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

async function listNetWorthTrend(openid, event) {
  const ev = event || {};
  const scope = String(ev.scope || "personal").trim() === "shared" ? "shared" : "personal";
  if (scope === "shared") {
    return { success: true, points: [] };
  }
  let res = await db.collection("asset_snapshots").where({ ownerOpenid: openid }).limit(200).get();
  let rows = (res.data || []).slice();
  if (!rows.length) {
    await rebuildAssetSnapshots(openid);
    res = await db.collection("asset_snapshots").where({ ownerOpenid: openid }).limit(200).get();
    rows = (res.data || []).slice();
  }
  rows.sort((a, b) => String(a.month || "").localeCompare(String(b.month || "")));
  const points = rows.map((row) => ({
    month: row.month,
    totalAssetsCents: Number(row.totalAssetsCents) || 0,
    totalLiabilitiesCents: Number(row.totalLiabilitiesCents) || 0,
    netWorthCents: Number(row.netWorthCents) || 0,
  }));
  return { success: true, points };
}

async function assertAssetAccountOwner(openid, accountId) {
  const acc = await getAssetAccountById(openid, accountId);
  if (!acc) {
    return { ok: false, errMsg: "仅账户户主可操作" };
  }
  return { ok: true, account: acc };
}

function normalizeAssetShareRole(raw) {
  return "viewer";
}

async function createAssetAccountShareInvite(openid, event) {
  const accountId = String((event && event.accountId) || "").trim();
  const gate = await assertAssetAccountOwner(openid, accountId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const role = normalizeAssetShareRole(event && event.role);
  const inviteCode = normalizeInviteCode(buildInviteCode());
  const rid = assetAccountShareInviteDocId(accountId, inviteCode);
  const expiresAt = new Date(Date.now() + DEFAULT_INVITE_EXPIRE_HOURS * 60 * 60 * 1000);
  await db.collection("asset_account_share_invites").doc(rid).set({
    data: {
      accountId,
      ownerOpenid: openid,
      code: inviteCode,
      role,
      status: "active",
      createdBy: openid,
      createdAt: db.serverDate(),
      expiresAt,
    },
  });
  return { success: true, inviteCode, accountId, role, expiresAt };
}

async function enterAssetAccountShare(openid, event) {
  const inviteCode = normalizeInviteCode(event && event.code);
  if (!inviteCode) {
    return { success: false, errMsg: "邀请码无效" };
  }
  const invRes = await db
    .collection("asset_account_share_invites")
    .where({ code: inviteCode, status: "active" })
    .limit(1)
    .get();
  const invite = (invRes.data && invRes.data[0]) || null;
  if (!invite) {
    return { success: false, errMsg: "邀请码无效或已失效" };
  }
  if (String(invite.ownerOpenid || "") === openid) {
    return { success: false, errMsg: "不能加入自己共享的账户" };
  }
  const expMs = readDateMs(invite.expiresAt);
  if (Number.isFinite(expMs) && expMs < Date.now()) {
    return { success: false, errMsg: "邀请码已过期" };
  }
  const account = await getAssetAccountById(String(invite.ownerOpenid || ""), invite.accountId);
  if (!account) {
    return { success: false, errMsg: "目标账户不存在" };
  }
  const sid = assetAccountShareDocId(openid, String(account._id));
  await db.collection("asset_account_shares").doc(sid).set({
    data: {
      accountId: String(account._id),
      ownerOpenid: String(account.ownerOpenid || ""),
      memberOpenid: openid,
      role: normalizeAssetShareRole(invite.role),
      status: "active",
      invitedBy: String(invite.createdBy || invite.ownerOpenid || ""),
      joinedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
  return { success: true, accountId: String(account._id), role: normalizeAssetShareRole(invite.role) };
}

async function listAssetAccountShareMembers(openid, event) {
  const accountId = String((event && event.accountId) || "").trim();
  const gate = await assertAssetAccountOwner(openid, accountId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const res = await db
    .collection("asset_account_shares")
    .where({ accountId, status: "active" })
    .limit(200)
    .get();
  const rows = res.data || [];
  const memberOpenids = rows
    .map((row) => String(row.memberOpenid || "").trim())
    .filter(Boolean);
  const profileMap = await fetchProfileMapByOpenids(memberOpenids);
  const list = rows.map((row) => {
    const memberOpenid = String(row.memberOpenid || "").trim();
    const p = profileMap[memberOpenid] || {};
    return {
      ...row,
      displayName: p.nickName || maskOpenidForDisplay(memberOpenid),
      avatarUrl: p.avatarUrl || "",
    };
  });
  return { success: true, list };
}

async function updateAssetAccountShareMemberRole(openid, event) {
  return { success: false, errMsg: "共享成员固定为只读，无需修改角色" };
}

async function removeAssetAccountShareMember(openid, event) {
  const accountId = String((event && event.accountId) || "").trim();
  const memberOpenid = String((event && event.memberOpenid) || "").trim();
  const gate = await assertAssetAccountOwner(openid, accountId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  if (!memberOpenid) {
    return { success: false, errMsg: "缺少成员" };
  }
  const sid = assetAccountShareDocId(memberOpenid, accountId);
  await db.collection("asset_account_shares").doc(sid).remove();
  return { success: true };
}

async function exitAssetAccountShare(openid, event) {
  const accountId = String((event && event.accountId) || "").trim();
  if (!accountId) {
    return { success: false, errMsg: "缺少账户" };
  }
  const sid = assetAccountShareDocId(openid, accountId);
  await db.collection("asset_account_shares").doc(sid).remove();
  return { success: true };
}

async function transferAssetAccountOwnership(openid, event) {
  const accountId = String((event && event.accountId) || "").trim();
  const newOwnerOpenid = String((event && event.newOwnerOpenid) || "").trim();
  const gate = await assertAssetAccountOwner(openid, accountId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const account = gate.account;
  if (account.archived === true) {
    return { success: false, errMsg: "已归档账户不可转让户主" };
  }
  if (!newOwnerOpenid) {
    return { success: false, errMsg: "缺少新户主" };
  }
  const oldOwnerOpenid = openid;
  if (newOwnerOpenid === oldOwnerOpenid) {
    return { success: false, errMsg: "不能转让给自己" };
  }
  const newOwnerShareId = assetAccountShareDocId(newOwnerOpenid, accountId);
  let newOwnerShare = null;
  try {
    const shareDoc = await db.collection("asset_account_shares").doc(newOwnerShareId).get();
    newOwnerShare = shareDoc.data || null;
  } catch (e) {
    newOwnerShare = null;
  }
  if (!newOwnerShare || String(newOwnerShare.status || "") !== "active") {
    return { success: false, errMsg: "新户主必须是当前共享成员" };
  }
  const oldOwnerShareId = assetAccountShareDocId(oldOwnerOpenid, accountId);
  try {
    await db.runTransaction(async (transaction) => {
      const accDoc = await transaction.collection("asset_accounts").doc(accountId).get();
      const accRow = accDoc && accDoc.data;
      if (!accRow || String(accRow.ownerOpenid || "") !== oldOwnerOpenid) {
        throw new Error("账户状态已变更，请刷新后重试");
      }
      await transaction.collection("asset_accounts").doc(accountId).update({
        data: { ownerOpenid: newOwnerOpenid, updatedAt: db.serverDate() },
      });
      await transaction.collection("asset_account_shares").doc(newOwnerShareId).remove();
      await transaction.collection("asset_account_shares").doc(oldOwnerShareId).set({
        data: {
          accountId,
          ownerOpenid: newOwnerOpenid,
          memberOpenid: oldOwnerOpenid,
          role: normalizeAssetShareRole("viewer"),
          status: "active",
          invitedBy: newOwnerOpenid,
          joinedAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "转让失败";
    return { success: false, errMsg: msg };
  }
  const recordsRes = await db
    .collection("asset_records")
    .where({ ownerOpenid: oldOwnerOpenid, accountId })
    .limit(2000)
    .get();
  const records = recordsRes.data || [];
  for (let i = 0; i < records.length; i += 1) {
    const row = records[i];
    await db.collection("asset_records").doc(String(row._id)).update({
      data: { ownerOpenid: newOwnerOpenid, updatedAt: db.serverDate() },
    });
  }
  const allSharesRes = await db
    .collection("asset_account_shares")
    .where({ accountId, status: "active" })
    .limit(200)
    .get();
  const allShares = allSharesRes.data || [];
  for (let i = 0; i < allShares.length; i += 1) {
    const row = allShares[i];
    if (String(row.ownerOpenid || "") === newOwnerOpenid) {
      continue;
    }
    await db.collection("asset_account_shares").doc(String(row._id)).update({
      data: { ownerOpenid: newOwnerOpenid, updatedAt: db.serverDate() },
    });
  }
  const invRes = await db
    .collection("asset_account_share_invites")
    .where({ accountId, status: "active" })
    .limit(50)
    .get();
  const invites = invRes.data || [];
  for (let i = 0; i < invites.length; i += 1) {
    await db.collection("asset_account_share_invites").doc(String(invites[i]._id)).update({
      data: { status: "revoked", updatedAt: db.serverDate() },
    });
  }
  const rebuilt = await rebuildAssetAccountBalanceChain(newOwnerOpenid, accountId);
  if (!rebuilt.ok) {
    return { success: false, errMsg: rebuilt.errMsg || "转让后重算失败" };
  }
  await rebuildAssetSnapshots(oldOwnerOpenid);
  await rebuildAssetSnapshots(newOwnerOpenid);
  return {
    success: true,
    accountId,
    newOwnerOpenid,
    previousOwnerOpenid: oldOwnerOpenid,
  };
}

function normalizeLedgerCategoryName(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, CATEGORY_NAME_MAX_LEN);
}

function dedupeCategoryList(arr) {
  const seen = new Set();
  const out = [];
  const list = Array.isArray(arr) ? arr : [];
  for (let i = 0; i < list.length; i += 1) {
    const s = normalizeLedgerCategoryName(list[i]);
    if (!s || seen.has(s)) {
      continue;
    }
    seen.add(s);
    out.push(s);
  }
  return out;
}

function getLedgerCategoriesList(ledger) {
  if (
    ledger &&
    Array.isArray(ledger.categories) &&
    ledger.categories.length > 0
  ) {
    return dedupeCategoryList(ledger.categories);
  }
  return dedupeCategoryList(mergeDefaultCategorySeed().slice());
}

function mergeDefaultCategorySeed() {
  return [].concat(DEFAULT_CATEGORIES, DEFAULT_INCOME_CATEGORIES);
}

function readLedgerCategoryByFlow(ledger) {
  const o = ledger && ledger.categoryByFlow;
  if (!o || typeof o !== "object") {
    return {};
  }
  const out = {};
  const keys = Object.keys(o);
  for (let i = 0; i < keys.length; i += 1) {
    const nk = normalizeLedgerCategoryName(keys[i]);
    if (!nk) {
      continue;
    }
    const v = o[keys[i]];
    if (v === "income" || v === "expense") {
      out[nk] = v;
    }
  }
  return out;
}

function isBuiltinPresetExpenseName(name) {
  const n = normalizeLedgerCategoryName(name);
  return n ? DEFAULT_CATEGORIES.indexOf(n) >= 0 : false;
}

function isBuiltinPresetIncomeName(name) {
  const n = normalizeLedgerCategoryName(name);
  return n ? DEFAULT_INCOME_CATEGORIES.indexOf(n) >= 0 : false;
}

/**
 * 分类与收支的对应：expense / income 为强绑定；both 为历史或未标记的自定义，收入与支出下均展示。
 */
function getCategoryKindForName(ledger, name) {
  const n = normalizeLedgerCategoryName(name);
  if (!n) {
    return "both";
  }
  if (isBuiltinPresetExpenseName(n)) {
    return "expense";
  }
  if (isBuiltinPresetIncomeName(n)) {
    return "income";
  }
  const m = readLedgerCategoryByFlow(ledger);
  if (m[n] === "income" || m[n] === "expense") {
    return m[n];
  }
  return "both";
}

function filterCategoriesByKind(fullList, ledger, targetFlow) {
  const list = Array.isArray(fullList) ? fullList : [];
  const want = targetFlow === "income" ? "income" : "expense";
  return list.filter((raw) => {
    const k = getCategoryKindForName(ledger, raw);
    if (k === "both") {
      return true;
    }
    return k === want;
  });
}

async function ensureDefaultIncomeCategoriesPresent(ledgerId) {
  const id = normalizeLedgerId(ledgerId);
  if (!id) {
    return;
  }
  const ledger = await fetchLedgerById(id);
  if (!ledger) {
    return;
  }
  let list = getLedgerCategoriesList(ledger);
  let changed = false;
  for (let i = 0; i < DEFAULT_INCOME_CATEGORIES.length; i += 1) {
    const d = DEFAULT_INCOME_CATEGORIES[i];
    if (list.indexOf(d) >= 0) {
      continue;
    }
    if (list.length >= MAX_LEDGER_CATEGORIES) {
      break;
    }
    list = list.concat([d]);
    changed = true;
  }
  if (!changed) {
    return;
  }
  const next = dedupeCategoryList(list);
  try {
    await db.collection("ledgers").doc(id).update({
      data: { categories: next },
    });
  } catch (e) {
    // ignore
  }
}

async function migrateLedgerCategoriesIfNeeded(ledgerId) {
  const id = normalizeLedgerId(ledgerId);
  if (!id) {
    return;
  }
  const ledger = await fetchLedgerById(id);
  if (!ledger) {
    return;
  }
  if (!Array.isArray(ledger.categories) || ledger.categories.length === 0) {
    try {
      await db.collection("ledgers").doc(id).update({
        data: { categories: mergeDefaultCategorySeed() },
      });
    } catch (e) {
      // ignore
    }
  }
}

async function buildCategoryListForLedger(ledgerId) {
  await migrateLedgerCategoriesIfNeeded(ledgerId);
  await ensureDefaultIncomeCategoriesPresent(ledgerId);
  const ledger = await fetchLedgerById(normalizeLedgerId(ledgerId));
  return getLedgerCategoriesList(ledger);
}

async function assertCategoryAllowedForLedgerWithFlow(ledgerId, rawCategory, flow) {
  const c = await assertCategoryAllowedForLedger(ledgerId, rawCategory);
  if (!c.ok) {
    return c;
  }
  const le = await fetchLedgerById(normalizeLedgerId(ledgerId));
  if (!le) {
    return { ok: false, errMsg: "账本不存在" };
  }
  const f = flow === "income" ? "income" : "expense";
  const kind = getCategoryKindForName(le, c.category);
  if (kind === "both" || kind === f) {
    return { ok: true, category: c.category };
  }
  return { ok: false, errMsg: "该分类与收入/支出类型不匹配" };
}

function normalizeTxFlow(tx) {
  if (tx && tx.flow === "income") {
    return "income";
  }
  return "expense";
}

function txMagnitudeCents(tx) {
  return Math.abs(Number(tx.amountCents) || 0);
}

/** 收入为正分、支出为负分，便于汇总净额 */
function txSignedCents(tx) {
  const mag = txMagnitudeCents(tx);
  if (mag <= 0) {
    return 0;
  }
  return normalizeTxFlow(tx) === "income" ? mag : -mag;
}

function formatSignedYuanFromCents(signedCents) {
  const n = Number(signedCents) || 0;
  const abs = Math.abs(n);
  const yuan = (abs / 100).toFixed(2);
  if (n > 0) {
    return `+${yuan}`;
  }
  if (n < 0) {
    return `-${yuan}`;
  }
  return "0.00";
}

async function assertCategoryAllowedForLedger(ledgerId, rawCategory) {
  const c = normalizeLedgerCategoryName(rawCategory);
  if (!c) {
    return { ok: false, errMsg: "请选择分类" };
  }
  const allowed = await buildCategoryListForLedger(ledgerId);
  if (allowed.includes(c)) {
    return { ok: true, category: c };
  }
  return { ok: false, errMsg: "分类无效，请先在「管理分类」中添加" };
}

function normalizeLedgerId(raw) {
  if (raw == null) {
    return "";
  }
  let s = String(raw).trim();
  if (!s || s === "undefined" || s === "null") {
    return "";
  }
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    // ignore
  }
  return String(s).trim();
}

function normalizeInviteCode(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .toUpperCase();
}

function buildInviteCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < INVITE_CODE_LEN; i += 1) {
    const idx = Math.floor(Math.random() * chars.length);
    out += chars[idx];
  }
  return out;
}

function readDateMs(v) {
  if (!v) {
    return NaN;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function chinaDateParts(v) {
  const ms = readDateMs(v);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const d = new Date(ms + CHINA_TZ_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

function chinaDayStartMsByYmd(year, month, day) {
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - CHINA_TZ_OFFSET_MS;
}

function chinaDayEndMsByYmd(year, month, day) {
  return chinaDayStartMsByYmd(year, month, day) + DAY_MS - 1;
}

function chinaDayStartMs(v) {
  const p = chinaDateParts(v);
  if (!p) {
    return NaN;
  }
  return chinaDayStartMsByYmd(p.year, p.month, p.day);
}

function formatChinaTimeText(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const d = new Date(ms + CHINA_TZ_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}`;
}

/** 当前用户作为成员所在账本 _id；默认仅未归档（与活跃 listLedgers / 全部账本统计一致） */
async function fetchLedgerIdsForMemberOpenid(openid, opts) {
  const activeOnly = !opts || opts.activeOnly !== false;
  const where = { memberOpenids: openid };
  if (activeOnly) {
    where.archived = _.neq(true);
  }
  const res = await db
    .collection("ledgers")
    .where(where)
    .field({ _id: true, archived: true })
    .get();
  const rows = res.data || [];
  const filtered = activeOnly
    ? rows.filter((r) => !isLedgerArchived(r))
    : rows;
  return filtered.map((r) => r._id).filter(Boolean);
}

/** 避免 doc().get() 在记录不存在时抛 document.get:fail（该错误会原样传到小程序 Toast） */
async function fetchLedgerById(rawId) {
  const ledgerId = normalizeLedgerId(rawId);
  if (!ledgerId) {
    return null;
  }
  try {
    const res = await db
      .collection("ledgers")
      .where({ _id: ledgerId })
      .limit(1)
      .get();
    const row = res.data && res.data[0];
    return row || null;
  } catch (e) {
    return null;
  }
}

/** 按条件分批删除文档（单次最多拉取 batch 条），避免一次 remove 条数上限 */
async function removeDocumentsWhere(collectionName, whereObj, batchSize) {
  const limit = Math.min(Math.max(Number(batchSize) || 100, 1), 100);
  const coll = db.collection(collectionName);
  for (;;) {
    const res = await coll.where(whereObj).limit(limit).get();
    const rows = res.data || [];
    if (!rows.length) {
      break;
    }
    const toRemove = [];
    for (let i = 0; i < rows.length; i += 1) {
      const id = rows[i]._id;
      if (id != null) {
        toRemove.push(String(id));
      }
    }
    for (let j = 0; j < toRemove.length; j += DB_REMOVE_CONCURRENCY) {
      const chunk = toRemove.slice(j, j + DB_REMOVE_CONCURRENCY);
      await Promise.all(
        chunk.map((id) =>
          coll.doc(id).remove().catch(() => {
            // 单条失败继续
          })
        )
      );
    }
  }
}

function isLedgerMemberPinned(memberRow) {
  if (!memberRow) {
    return false;
  }
  const v = memberRow.pinned;
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function readLedgerMemberPinnedAtMs(memberRow) {
  if (!isLedgerMemberPinned(memberRow)) {
    return 0;
  }
  const ms = readDateMs(memberRow.pinnedAt);
  return Number.isFinite(ms) ? ms : 0;
}

async function fetchLedgerMemberPinMap(openid, ledgerIds) {
  const map = Object.create(null);
  const ids = (Array.isArray(ledgerIds) ? ledgerIds : [])
    .map((id) => normalizeLedgerId(id))
    .filter(Boolean);
  if (!ids.length || !openid) {
    return map;
  }
  const docIds = ids.map((ledgerId) => memberDocId(openid, ledgerId));
  for (let i = 0; i < docIds.length; i += 20) {
    const chunk = docIds.slice(i, i + 20);
    const res = await db
      .collection("ledger_members")
      .where({ _id: _.in(chunk) })
      .field({ ledgerId: true, pinned: true, pinnedAt: true })
      .limit(20)
      .get();
    (res.data || []).forEach((row) => {
      const ledgerId = normalizeLedgerId(row && row.ledgerId);
      if (!ledgerId) {
        return;
      }
      map[ledgerId] = {
        pinned: isLedgerMemberPinned(row),
        pinnedAtMs: readLedgerMemberPinnedAtMs(row),
      };
    });
  }
  return map;
}

async function ledgerMemberRowExists(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return false;
  }
  const mid = memberDocId(openid, ledgerId);
  try {
    const res = await db
      .collection("ledger_members")
      .where({ _id: mid })
      .limit(1)
      .get();
    return !!(res.data && res.data[0]);
  } catch (e) {
    return false;
  }
}

function isLedgerCreator(ledger, openid) {
  if (!ledger || !openid) {
    return false;
  }
  return (
    ledger.creatorOpenid === openid ||
    (!ledger.creatorOpenid &&
      Array.isArray(ledger.memberOpenids) &&
      ledger.memberOpenids[0] === openid)
  );
}

function isLedgerArchived(ledger) {
  if (!ledger) {
    return false;
  }
  const v = ledger.archived;
  // 旧数据无 archived 字段视为未归档；仅显式 true 才算已归档
  return v === true;
}

function parseLedgerArchivedOnlyFlag(ev) {
  const raw = ev && ev.archivedOnly;
  return raw === true || raw === 1 || raw === "1" || String(raw).toLowerCase() === "true";
}

function assertLedgerNotArchived(ledger) {
  if (isLedgerArchived(ledger)) {
    return { ok: false, errMsg: "账本已归档，请先恢复后再操作" };
  }
  return { ok: true };
}

/** 是否允许当前用户编辑/删除该条流水（协作者不可改删他人记录）。 */
function transactionEditableByCaller(openid, tx, ledger) {
  const caller = String(openid || "").trim();
  if (!caller || !tx) {
    return false;
  }
  const author = String(tx.createdByOpenid || "").trim();
  if (author) {
    return author === caller;
  }
  return ledger && isLedgerCreator(ledger, caller);
}

async function ensureLedgerMemberRow(openid, rawLedgerId, roleHint) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId || !openid) {
    return;
  }
  const has = await ledgerMemberRowExists(openid, ledgerId);
  if (has) {
    return;
  }
  await db
    .collection("ledger_members")
    .doc(memberDocId(openid, ledgerId))
    .set({
      data: {
        ledgerId,
        openid,
        role: roleHint === "owner" ? "owner" : "member",
        joinedAt: db.serverDate(),
      },
    });
}

async function getJoinRequest(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId || !openid) {
    return null;
  }
  const id = joinRequestDocId(openid, ledgerId);
  try {
    const res = await db
      .collection("ledger_join_requests")
      .where({ _id: id })
      .limit(1)
      .get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function upsertJoinRequestPending(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId || !openid) {
    return;
  }
  const id = joinRequestDocId(openid, ledgerId);
  await db
    .collection("ledger_join_requests")
    .doc(id)
    .set({
      data: {
        ledgerId,
        applicantOpenid: openid,
        status: "pending",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        reviewedAt: null,
        reviewedByOpenid: "",
      },
    });
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  if (wxContext.SOURCE === "wx_trigger" || (event && event.Type === "timer")) {
    try {
      await ensureCollections();
      return await processDueSchedules();
    } catch (e) {
      console.error("processDueSchedules", e);
      return { ok: false, err: e && e.message ? String(e.message) : String(e) };
    }
  }

  // 资源共享跨小程序调用时，调用方身份可能出现在 FROM_OPENID
  const openid = String(wxContext.OPENID || wxContext.FROM_OPENID || "").trim();
  if (!openid) {
    console.error("missing openid in wxContext", wxContext);
    return {
      success: false,
      errMsg: "未获取到 openid",
      debug: {
        appid: wxContext.APPID || "",
        fromAppid: wxContext.FROM_APPID || "",
      },
    };
  }

  const { type } = event;

  try {
    await ensureCollections();
    switch (type) {
      case "createLedger":
        return await createLedger(openid, event);
      case "updateLedgerName":
        return await updateLedgerName(openid, event);
      case "updateLedgerMonthlyBudget":
        return await updateLedgerMonthlyBudget(openid, event);
      case "updateLedgerDefaultAssetAccount":
        return await updateLedgerDefaultAssetAccount(openid, event);
      case "listLedgers":
        return await listLedgers(openid, event);
      case "setLedgerPinned":
        return await setLedgerPinned(openid, event);
      case "archiveLedger":
        return await archiveLedger(openid, event);
      case "enterLedger":
        return await enterLedger(openid, event);
      case "joinLedger":
        return await joinLedger(openid, event);
      case "createLedgerInvite":
        return await createLedgerInvite(openid, event);
      case "listLedgerCollaborators":
        return await listLedgerCollaborators(openid, event);
      case "reviewJoinRequest":
        return await reviewJoinRequest(openid, event);
      case "removeCollaborator":
        return await removeCollaborator(openid, event);
      case "exitLedger":
        return await exitLedger(openid, event);
      case "getLedger":
        return await getLedger(openid, event.ledgerId);
      case "deleteLedger":
        return await deleteLedger(openid, event);
      case "listCategories":
        return await listCategories(openid, event);
      case "addLedgerCategory":
        return await addLedgerCategory(openid, event);
      case "removeLedgerCategory":
        return await removeLedgerCategory(openid, event);
      case "listTransactions":
        return await listTransactions(openid, event.ledgerId);
      case "addTransaction":
        return await addTransaction(openid, event);
      case "analyzeLedger":
        return await analyzeLedger(openid, event);
      case "listGroupTransactions":
        return await listGroupTransactions(openid, event);
      case "getTransaction":
        return await getTransaction(openid, event);
      case "updateTransaction":
        return await updateTransaction(openid, event);
      case "deleteTransaction":
        return await deleteTransaction(openid, event);
      case "listMySchedules":
        return await listMySchedules(openid);
      case "createSchedule":
        return await createSchedule(openid, event);
      case "getSchedule":
        return await getSchedule(openid, event);
      case "updateSchedule":
        return await updateSchedule(openid, event);
      case "deleteSchedule":
        return await deleteSchedule(openid, event);
      case "getMyProfile":
        return await getMyProfile(openid);
      case "updateMyProfile":
        return await updateMyProfile(openid, event);
      case "createAssetAccount":
        return await createAssetAccount(openid, event);
      case "listAssetAccounts":
        return await listAssetAccounts(openid, event);
      case "getAssetAccount":
        return await getAssetAccount(openid, event);
      case "updateAssetAccount":
        return await updateAssetAccount(openid, event);
      case "archiveAssetAccount":
        return await archiveAssetAccount(openid, event);
      case "deleteAssetAccount":
        return await deleteAssetAccount(openid, event);
      case "getAssetDashboard":
        return await getAssetDashboard(openid, event);
      case "createAssetRecord":
        return await createAssetRecord(openid, event);
      case "listAssetRecords":
        return await listAssetRecords(openid, event);
      case "getAssetRecord":
        return await getAssetRecord(openid, event);
      case "updateAssetRecord":
        return await updateAssetRecord(openid, event);
      case "deleteAssetRecord":
        return await deleteAssetRecord(openid, event);
      case "createAssetTransfer":
        return await createAssetTransfer(openid, event);
      case "listNetWorthTrend":
        return await listNetWorthTrend(openid, event);
      case "createAssetAccountShareInvite":
        return await createAssetAccountShareInvite(openid, event);
      case "enterAssetAccountShare":
        return await enterAssetAccountShare(openid, event);
      case "listAssetAccountShareMembers":
        return await listAssetAccountShareMembers(openid, event);
      case "updateAssetAccountShareMemberRole":
        return await updateAssetAccountShareMemberRole(openid, event);
      case "removeAssetAccountShareMember":
        return await removeAssetAccountShareMember(openid, event);
      case "exitAssetAccountShare":
        return await exitAssetAccountShare(openid, event);
      case "transferAssetAccountOwnership":
        return await transferAssetAccountOwnership(openid, event);
      default:
        return { success: false, errMsg: "未知 type" };
    }
  } catch (e) {
    const raw = e.message || String(e);
    if (/document\.get:fail|DOCUMENT_GET/i.test(raw)) {
      return {
        success: false,
        errMsg: "未找到账本，分享链接可能不完整或已失效，请让对方重新分享",
      };
    }
    return { success: false, errMsg: raw };
  }
};

async function assertMember(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { ok: false, errMsg: "账本链接无效" };
  }
  const data = await fetchLedgerById(ledgerId);
  if (!data || !Array.isArray(data.memberOpenids)) {
    return { ok: false, errMsg: "账本不存在" };
  }
  const members = data.memberOpenids || [];
  if (!members.includes(openid)) {
    return { ok: false, errMsg: "无权访问该账本" };
  }
  return { ok: true, ledger: data };
}

async function createLedger(openid, event) {
  const name = normalizeLedgerName(event.name) || "未命名账本";
  const addRes = await db.collection("ledgers").add({
    data: {
      name,
      creatorOpenid: openid,
      memberOpenids: [openid],
      categories: mergeDefaultCategorySeed().slice(),
      archived: false,
      createdAt: db.serverDate(),
    },
  });
  const ledgerId = addRes._id;
  await db
    .collection("ledger_members")
    .doc(memberDocId(openid, ledgerId))
    .set({
      data: {
        ledgerId,
        openid,
        role: "owner",
        joinedAt: db.serverDate(),
      },
    });
  return { success: true, ledgerId };
}

async function updateLedgerName(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const ledgerName = normalizeLedgerName(event.name);
  if (!ledgerName) {
    return { success: false, errMsg: "请输入账本名称" };
  }
  await db.collection("ledgers").doc(gate.ledgerId).update({
    data: {
      name: ledgerName,
      updatedAt: db.serverDate(),
    },
  });
  return { success: true, name: ledgerName };
}

async function updateLedgerMonthlyBudget(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const clear =
    event.clearBudget === true ||
    event.monthlyBudgetCents === null ||
    event.monthlyBudgetCents === "";
  if (clear) {
    await db.collection("ledgers").doc(gate.ledgerId).update({
      data: {
        monthlyBudgetCents: _.remove(),
        updatedAt: db.serverDate(),
      },
    });
    return { success: true, monthlyBudgetCents: null };
  }
  const cents = Math.floor(Number(event.monthlyBudgetCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    return { success: false, errMsg: "请输入大于 0 的预算金额" };
  }
  if (cents > MAX_MONTHLY_BUDGET_CENTS) {
    return { success: false, errMsg: "预算金额过大" };
  }
  await db.collection("ledgers").doc(gate.ledgerId).update({
    data: {
      monthlyBudgetCents: cents,
      updatedAt: db.serverDate(),
    },
  });
  return { success: true, monthlyBudgetCents: cents };
}

async function updateLedgerDefaultAssetAccount(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const clear =
    event.clearDefault === true ||
    event.assetAccountId === null ||
    event.assetAccountId === "";
  if (clear) {
    await db.collection("ledgers").doc(gate.ledgerId).update({
      data: {
        defaultAssetAccountId: _.remove(),
        defaultAssetAccountName: _.remove(),
        updatedAt: db.serverDate(),
      },
    });
    return {
      success: true,
      defaultAssetAccountId: null,
      defaultAssetAccountName: null,
    };
  }
  const link = await normalizeOptionalAssetLink(openid, event.assetAccountId);
  if (!link.ok) {
    return { success: false, errMsg: link.errMsg || "资产账户无效" };
  }
  await db.collection("ledgers").doc(gate.ledgerId).update({
    data: {
      defaultAssetAccountId: link.assetAccountId,
      defaultAssetAccountName: link.assetAccountName,
      updatedAt: db.serverDate(),
    },
  });
  return {
    success: true,
    defaultAssetAccountId: link.assetAccountId,
    defaultAssetAccountName: link.assetAccountName,
  };
}

function getChinaMonthWindowForList(now = new Date()) {
  const p = chinaDateParts(now);
  if (!p) {
    const d = now instanceof Date ? now : new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      startMs: chinaDayStartMsByYmd(y, m, 1),
      endMs: chinaDayEndMsByYmd(y, m, lastDay),
      label: `${y}年${m}月`,
    };
  }
  const y = p.year;
  const m = p.month;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    startMs: chinaDayStartMsByYmd(y, m, 1),
    endMs: chinaDayEndMsByYmd(y, m, lastDay),
    label: `${y}年${m}月`,
  };
}

async function sumLedgerTransactionsInTimeRange(ledgerId, startMs, endMs) {
  let incomeCents = 0;
  let expenseCents = 0;
  const id = normalizeLedgerId(ledgerId);
  if (!id || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { incomeCents: 0, expenseCents: 0 };
  }
  try {
    const res = await db
      .collection("transactions")
      .where({ ledgerId: id })
      .field({ amountCents: true, flow: true, bookedAt: true, createdAt: true })
      .limit(1000)
      .get();
    const rows = res.data || [];
    for (let i = 0; i < rows.length; i += 1) {
      const tx = rows[i];
      const t = txTimeMs(tx);
      if (t < startMs || t > endMs) {
        continue;
      }
      const mag = txMagnitudeCents(tx);
      if (mag <= 0) {
        continue;
      }
      if (normalizeTxFlow(tx) === "income") {
        incomeCents += mag;
      } else {
        expenseCents += mag;
      }
    }
  } catch (e) {
    // ignore
  }
  return { incomeCents, expenseCents };
}

async function listLedgers(openid, event) {
  const ev = event && typeof event === "object" ? event : {};
  const archivedOnly = parseLedgerArchivedOnlyFlag(ev);
  const ledgerFields = {
    name: true,
    createdAt: true,
    memberOpenids: true,
    creatorOpenid: true,
    monthlyBudgetCents: true,
    defaultAssetAccountId: true,
    archived: true,
  };
  const where = { memberOpenids: openid };
  if (archivedOnly) {
    where.archived = true;
  } else {
    // 与 listAssetAccounts 一致：无 archived 字段的旧账本归入「未归档」
    where.archived = _.neq(true);
  }
  let res = await db
    .collection("ledgers")
    .where(where)
    .field(ledgerFields)
    .get();
  let rows = res.data || [];
  if (!archivedOnly && rows.length === 0) {
    const created = await createLedger(openid, { name: "我的账本" });
    if (!created.success) {
      return {
        success: false,
        errMsg: created.errMsg || "创建默认账本失败",
        list: [],
      };
    }
    res = await db
      .collection("ledgers")
      .where(where)
      .field(ledgerFields)
      .get();
    rows = res.data || [];
  }
  if (archivedOnly) {
    rows = rows.filter((doc) => isLedgerArchived(doc));
  } else {
    rows = rows.filter((doc) => !isLedgerArchived(doc));
  }
  const pinMap = await fetchLedgerMemberPinMap(
    openid,
    rows.map((doc) => doc && doc._id)
  );
  rows.sort((a, b) => {
    const pa = pinMap[a._id] && pinMap[a._id].pinned ? 1 : 0;
    const pb = pinMap[b._id] && pinMap[b._id].pinned ? 1 : 0;
    if (pa !== pb) {
      return pb - pa;
    }
    if (pa && pb) {
      const pta = (pinMap[a._id] && pinMap[a._id].pinnedAtMs) || 0;
      const ptb = (pinMap[b._id] && pinMap[b._id].pinnedAtMs) || 0;
      if (pta !== ptb) {
        return ptb - pta;
      }
    }
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  const creatorLedgerIds = rows
    .filter(
      (doc) =>
        doc &&
        (doc.creatorOpenid === openid ||
          (!doc.creatorOpenid &&
            Array.isArray(doc.memberOpenids) &&
            doc.memberOpenids[0] === openid))
    )
    .map((doc) => normalizeLedgerId(doc && doc._id))
    .filter(Boolean);
  const pendingCountMap = Object.create(null);
  if (creatorLedgerIds.length) {
    const pendingRes = await db
      .collection("ledger_join_requests")
      .where({
        ledgerId: _.in(creatorLedgerIds),
        status: "pending",
      })
      .field({
        ledgerId: true,
        applicantOpenid: true,
      })
      .limit(100)
      .get();
    const pendingRows = pendingRes.data || [];
    pendingRows.forEach((row) => {
      const ledgerId = normalizeLedgerId(row && row.ledgerId);
      const applicantOpenid = String((row && row.applicantOpenid) || "").trim();
      if (!ledgerId || !applicantOpenid) {
        return;
      }
      if (pendingCountMap[ledgerId] == null) {
        pendingCountMap[ledgerId] = 0;
      }
      pendingCountMap[ledgerId] += 1;
    });
  }
  const monthWin = getChinaMonthWindowForList(new Date());
  const monthSums = await Promise.all(
    rows.map((doc) =>
      sumLedgerTransactionsInTimeRange(doc._id, monthWin.startMs, monthWin.endMs)
    )
  );
  const list = rows.map((doc, idx) => {
    const sums = monthSums[idx] || { incomeCents: 0, expenseCents: 0 };
    const budget = readMonthlyBudgetCents(doc);
    const pinInfo = pinMap[doc._id] || { pinned: false, pinnedAtMs: 0 };
    return {
      _id: doc._id,
      name: doc.name,
      pinned: !!pinInfo.pinned,
      memberCount: (doc.memberOpenids || []).length,
      /** 毫秒时间戳，供统计页按账本创建日生成可选周期 */
      createdAtMs: (() => {
        const ms = readDateMs(doc.createdAt);
        return Number.isFinite(ms) ? ms : Date.now();
      })(),
      isCreator:
        doc.creatorOpenid === openid ||
        (!doc.creatorOpenid &&
          Array.isArray(doc.memberOpenids) &&
          doc.memberOpenids[0] === openid),
      pendingRequestCount: Number(pendingCountMap[doc._id] || 0),
      monthIncomeCents: sums.incomeCents,
      monthExpenseCents: sums.expenseCents,
      monthSummaryLabel: monthWin.label,
      monthlyBudgetCents: budget,
      defaultAssetAccountId: readLedgerDefaultAssetAccountId(doc),
      archived: isLedgerArchived(doc),
    };
  });
  return { success: true, list };
}

async function setLedgerPinned(openid, event) {
  const ev = event && typeof event === "object" ? event : {};
  const ledgerId = normalizeLedgerId(ev.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const pinned = !(
    ev.pinned === false ||
    ev.pinned === 0 ||
    String(ev.pinned || "").toLowerCase() === "false"
  );
  await ensureLedgerMemberRow(
    openid,
    ledgerId,
    isLedgerCreator(gate.ledger, openid) ? "owner" : "member"
  );
  const patch = pinned
    ? { pinned: true, pinnedAt: db.serverDate() }
    : { pinned: false, pinnedAt: null };
  await db
    .collection("ledger_members")
    .doc(memberDocId(openid, ledgerId))
    .update({ data: patch });
  return { success: true, pinned };
}

/**
 * 分享落地页专用：同一云函数内完成「加入成员 + 读回账本」，
 * 避免连续两次 callFunction 时数据库读副本尚未同步导致误判「无权访问」。
 */
async function verifyLedgerInviteForJoin(ledgerId, rawInviteCode) {
  const inviteCode = normalizeInviteCode(rawInviteCode);
  if (!inviteCode) {
    return {
      ok: false,
      code: "INVITE_REQUIRED",
      errMsg: "分享口令缺失，请让创建人重新分享链接",
    };
  }
  const rid = inviteDocId(ledgerId, inviteCode);
  const res = await db
    .collection("ledger_invites")
    .where({ _id: rid })
    .limit(1)
    .get();
  const row = (res.data && res.data[0]) || null;
  if (!row || row.status !== "active") {
    return {
      ok: false,
      code: "INVITE_INVALID",
      errMsg: "邀请码无效，请让创建人重新分享",
    };
  }
  const expMs = readDateMs(row.expiresAt);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    try {
      await db.collection("ledger_invites").doc(rid).update({
        data: {
          status: "expired",
          updatedAt: db.serverDate(),
        },
      });
    } catch (e) {
      // ignore
    }
    return {
      ok: false,
      code: "INVITE_EXPIRED",
      errMsg: "邀请码已过期，请让创建人重新分享",
    };
  }
  return { ok: true };
}

async function createLedgerInvite(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const ledgerId = gate.ledgerId;
  const hoursRaw = Number(event.expireHours);
  const expireHours = Math.min(
    MAX_INVITE_EXPIRE_HOURS,
    Math.max(1, Number.isFinite(hoursRaw) ? Math.floor(hoursRaw) : DEFAULT_INVITE_EXPIRE_HOURS)
  );
  const expireAtMs = Date.now() + expireHours * 60 * 60 * 1000;
  let inviteCode = "";
  for (let i = 0; i < 5; i += 1) {
    const candidate = buildInviteCode();
    const rid = inviteDocId(ledgerId, candidate);
    const exists = await db
      .collection("ledger_invites")
      .where({ _id: rid })
      .limit(1)
      .get();
    if (!exists.data || !exists.data[0]) {
      inviteCode = candidate;
      break;
    }
  }
  if (!inviteCode) {
    return { success: false, errMsg: "邀请码生成失败，请稍后重试" };
  }
  await db
    .collection("ledger_invites")
    .doc(inviteDocId(ledgerId, inviteCode))
    .set({
      data: {
        ledgerId,
        inviteCode,
        creatorOpenid: openid,
        status: "active",
        expireHours,
        expiresAt: new Date(expireAtMs),
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
  return {
    success: true,
    inviteCode,
    expireHours,
    expiresAtMs: expireAtMs,
    expiresAtText: formatChinaTimeText(expireAtMs),
  };
}

async function enterLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event && event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "账本链接无效，请重新分享" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { success: false, errMsg: "账本不存在或已删除" };
  }

  if (!ledger.memberOpenids.includes(openid)) {
    if (isLedgerArchived(ledger)) {
      return {
        success: false,
        errMsg: "账本已归档，暂不接受新成员加入",
      };
    }
    const inviteCheck = await verifyLedgerInviteForJoin(
      ledgerId,
      event && event.inviteCode
    );
    if (!inviteCheck.ok) {
      return {
        success: false,
        code: inviteCheck.code,
        errMsg: inviteCheck.errMsg,
      };
    }
    await upsertJoinRequestPending(openid, ledgerId);
    return {
      success: false,
      code: "PENDING_APPROVAL",
      errMsg: "已提交加入申请，等待账本创建人同意后即可进入",
    };
  }

  await ensureLedgerMemberRow(
    openid,
    ledgerId,
    isLedgerCreator(ledger, openid) ? "owner" : "member"
  );

  await migrateLedgerCategoriesIfNeeded(ledgerId);
  const fresh = await fetchLedgerById(ledgerId);
  if (!fresh || !Array.isArray(fresh.memberOpenids)) {
    return { success: false, errMsg: "账本不存在" };
  }

  const categories = await buildCategoryListForLedger(ledgerId);
  const le = await fetchLedgerById(ledgerId);
  const pinMap = await fetchLedgerMemberPinMap(openid, [ledgerId]);
  const pinInfo = pinMap[ledgerId] || { pinned: false };

  return {
    success: true,
    ledger: {
      _id: ledgerId,
      name: fresh.name,
      memberCount: fresh.memberOpenids.length,
      categories,
      expenseList: filterCategoriesByKind(categories, le, "expense"),
      incomeList: filterCategoriesByKind(categories, le, "income"),
      monthlyBudgetCents: readMonthlyBudgetCents(fresh),
      defaultAssetAccountId: readLedgerDefaultAssetAccountId(fresh),
      defaultAssetAccountName: readLedgerDefaultAssetAccountName(fresh),
      isCreator: isLedgerCreator(fresh, openid),
      archived: isLedgerArchived(fresh),
      pinned: !!pinInfo.pinned,
    },
  };
}

async function joinLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event && event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { success: false, errMsg: "账本不存在" };
  }
  if (isLedgerArchived(ledger)) {
    return { success: false, errMsg: "账本已归档，暂不接受新成员加入" };
  }

  if (ledger.memberOpenids.includes(openid)) {
    await ensureLedgerMemberRow(
      openid,
      ledgerId,
      isLedgerCreator(ledger, openid) ? "owner" : "member"
    );
    return { success: true, status: "already_member" };
  }

  const inviteCheck = await verifyLedgerInviteForJoin(
    ledgerId,
    event && event.inviteCode
  );
  if (!inviteCheck.ok) {
    return {
      success: false,
      code: inviteCheck.code,
      errMsg: inviteCheck.errMsg,
    };
  }
  await upsertJoinRequestPending(openid, ledgerId);
  return { success: true, status: "pending_approval" };
}

async function assertCreator(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { ok: false, errMsg: "缺少 ledgerId" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { ok: false, errMsg: "账本不存在" };
  }
  if (!isLedgerCreator(ledger, openid)) {
    return { ok: false, errMsg: "仅创建者可操作" };
  }
  return { ok: true, ledger, ledgerId };
}

async function listLedgerCollaborators(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const { ledger, ledgerId } = gate;
  const memberOpenids = Array.isArray(ledger.memberOpenids)
    ? ledger.memberOpenids.filter(Boolean)
    : [];
  const creatorOpenid =
    ledger.creatorOpenid || (memberOpenids.length ? memberOpenids[0] : "");
  const collaboratorOpenids = memberOpenids.filter((oid) => oid !== creatorOpenid);
  const pendingRes = await db
    .collection("ledger_join_requests")
    .where({ ledgerId, status: "pending" })
    .limit(100)
    .get();
  const pendingRows = pendingRes.data || [];
  const pendingOpenids = pendingRows
    .map((row) => String(row.applicantOpenid || "").trim())
    .filter(Boolean);
  const profileMap = await fetchProfileMapByOpenids(
    collaboratorOpenids.concat(pendingOpenids)
  );
  const collaborators = collaboratorOpenids.map((oid) => ({
    openid: oid,
    displayName:
      (profileMap[oid] && profileMap[oid].nickName) || maskOpenidForDisplay(oid),
    avatarUrl: (profileMap[oid] && profileMap[oid].avatarUrl) || "",
  }));
  const pendingRequests = pendingRows
    .map((row) => {
      const applicantOpenid = String(row.applicantOpenid || "").trim();
      if (!applicantOpenid || memberOpenids.includes(applicantOpenid)) {
        return null;
      }
      return {
        openid: applicantOpenid,
        displayName:
          (profileMap[applicantOpenid] &&
            profileMap[applicantOpenid].nickName) ||
          maskOpenidForDisplay(applicantOpenid),
        avatarUrl: (profileMap[applicantOpenid] && profileMap[applicantOpenid].avatarUrl) || "",
      };
    })
    .filter(Boolean);
  return {
    success: true,
    creatorOpenid,
    collaborators,
    pendingRequests,
  };
}

async function reviewJoinRequest(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const { ledgerId } = gate;
  const applicantOpenid = String(event.applicantOpenid || "").trim();
  if (!applicantOpenid) {
    return { success: false, errMsg: "缺少申请人" };
  }
  if (applicantOpenid === openid) {
    return { success: false, errMsg: "无需审批创建者本人" };
  }
  const req = await getJoinRequest(applicantOpenid, ledgerId);
  if (!req || req.status !== "pending") {
    return { success: false, errMsg: "申请不存在或已处理" };
  }
  const approve = !!event.approve;
  if (approve) {
    await db.collection("ledgers").doc(ledgerId).update({
      data: {
        memberOpenids: _.addToSet(applicantOpenid),
      },
    });
    await ensureLedgerMemberRow(applicantOpenid, ledgerId, "member");
  }
  await db
    .collection("ledger_join_requests")
    .doc(joinRequestDocId(applicantOpenid, ledgerId))
    .update({
      data: {
        status: approve ? "approved" : "rejected",
        reviewedAt: db.serverDate(),
        reviewedByOpenid: openid,
        updatedAt: db.serverDate(),
      },
    });
  return { success: true };
}

async function removeCollaborator(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const { ledger, ledgerId } = gate;
  const targetOpenid = String(event.targetOpenid || "").trim();
  if (!targetOpenid) {
    return { success: false, errMsg: "缺少成员信息" };
  }
  if (isLedgerCreator(ledger, targetOpenid)) {
    return { success: false, errMsg: "不能移除创建者本人" };
  }
  if (!Array.isArray(ledger.memberOpenids) || !ledger.memberOpenids.includes(targetOpenid)) {
    return { success: false, errMsg: "该成员不在账本中" };
  }
  await db.collection("ledgers").doc(ledgerId).update({
    data: {
      memberOpenids: _.pull(targetOpenid),
    },
  });
  try {
    await db
      .collection("ledger_members")
      .doc(memberDocId(targetOpenid, ledgerId))
      .remove();
  } catch (e) {
    // ignore
  }
  try {
    await db
      .collection("ledger_join_requests")
      .doc(joinRequestDocId(targetOpenid, ledgerId))
      .remove();
  } catch (e) {
    // ignore
  }
  // 被移除后，移除对该账本的定时记账任务，避免继续入账。
  await removeDocumentsWhere("ledger_schedules", {
    ledgerId,
    ownerOpenid: targetOpenid,
  }, 100);
  return { success: true };
}

async function exitLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const ledger = gate.ledger;
  if (isLedgerCreator(ledger, openid)) {
    return { success: false, errMsg: "创建者不能退出账本，请删除账本" };
  }
  await db.collection("ledgers").doc(ledgerId).update({
    data: {
      memberOpenids: _.pull(openid),
    },
  });
  try {
    await db
      .collection("ledger_members")
      .doc(memberDocId(openid, ledgerId))
      .remove();
  } catch (e) {
    // ignore
  }
  try {
    await db
      .collection("ledger_join_requests")
      .doc(joinRequestDocId(openid, ledgerId))
      .remove();
  } catch (e) {
    // ignore
  }
  await removeDocumentsWhere(
    "ledger_schedules",
    {
      ledgerId,
      ownerOpenid: openid,
    },
    100
  );
  return { success: true };
}

async function getLedger(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const categories = await buildCategoryListForLedger(ledgerId);
  const ledger = await fetchLedgerById(ledgerId);
  const row = ledger || gate.ledger;
  const pinMap = await fetchLedgerMemberPinMap(openid, [ledgerId]);
  const pinInfo = pinMap[ledgerId] || { pinned: false };
  return {
    success: true,
    ledger: {
      _id: ledgerId,
      name: (ledger && ledger.name) || gate.ledger.name,
      memberCount: ((ledger && ledger.memberOpenids) || gate.ledger.memberOpenids || [])
        .length,
      categories,
      expenseList: filterCategoriesByKind(categories, row, "expense"),
      incomeList: filterCategoriesByKind(categories, row, "income"),
      monthlyBudgetCents: readMonthlyBudgetCents(row),
      defaultAssetAccountId: readLedgerDefaultAssetAccountId(row),
      defaultAssetAccountName: readLedgerDefaultAssetAccountName(row),
      isCreator:
        row.creatorOpenid === openid ||
        (!row.creatorOpenid &&
          row.memberOpenids &&
          row.memberOpenids[0] === openid),
      archived: isLedgerArchived(row),
      pinned: !!pinInfo.pinned,
    },
  };
}

async function archiveLedger(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const archived = event.archived !== false;
  await db.collection("ledgers").doc(gate.ledgerId).update({
    data: {
      archived,
      updatedAt: db.serverDate(),
    },
  });
  return { success: true, archived };
}

async function deleteLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { success: false, errMsg: "账本不存在" };
  }
  const creator =
    ledger.creatorOpenid ||
    (Array.isArray(ledger.memberOpenids) && ledger.memberOpenids[0]) ||
    "";
  if (creator !== openid) {
    return { success: false, errMsg: "仅创建者可删除账本" };
  }
  if (!isLedgerArchived(ledger)) {
    return { success: false, errMsg: "请先归档账本后再删除" };
  }
  try {
    await removeDocumentsWhere("transactions", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_schedules", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_members", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_join_requests", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_invites", { ledgerId }, 100);
    await db.collection("ledgers").doc(ledgerId).remove();
  } catch (e) {
    return { success: false, errMsg: "删除失败，请重试" };
  }
  return { success: true };
}

async function listCategories(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const list = await buildCategoryListForLedger(ledgerId);
  const le = await fetchLedgerById(ledgerId);
  return {
    success: true,
    list,
    expenseList: filterCategoriesByKind(list, le, "expense"),
    incomeList: filterCategoriesByKind(list, le, "income"),
  };
}

async function addLedgerCategory(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const name = normalizeLedgerCategoryName(event.name);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  if (!name) {
    return { success: false, errMsg: "请输入分类名称" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }

  let flowToStore = null;
  if (!isBuiltinPresetExpenseName(name) && !isBuiltinPresetIncomeName(name)) {
    if (event.forFlow === "income" || event.forFlow === "expense") {
      flowToStore = event.forFlow;
    } else {
      flowToStore = "expense";
    }
  }

  const targetIds = await fetchLedgerIdsForMemberOpenid(openid);
  if (!targetIds.length) {
    return { success: false, errMsg: "未找到账本" };
  }

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    const list = getLedgerCategoriesList(row);
    if (list.includes(name)) {
      continue;
    }
    if (list.length >= MAX_LEDGER_CATEGORIES) {
      return {
        success: false,
        errMsg: `有账本已达 ${MAX_LEDGER_CATEGORIES} 个分类上限，无法同步添加`,
      };
    }
  }

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    let list = getLedgerCategoriesList(row);
    if (list.includes(name)) {
      continue;
    }
    list = list.concat([name]);
    const patch = { categories: list };
    if (flowToStore) {
      const m = readLedgerCategoryByFlow(row);
      m[name] = flowToStore;
      patch.categoryByFlow = m;
    }
    try {
      await db.collection("ledgers").doc(id).update({
        data: patch,
      });
    } catch (e) {
      return { success: false, errMsg: "添加失败，请重试" };
    }
  }

  const list = await buildCategoryListForLedger(ledgerId);
  const le = await fetchLedgerById(ledgerId);
  return {
    success: true,
    list,
    expenseList: filterCategoriesByKind(list, le, "expense"),
    incomeList: filterCategoriesByKind(list, le, "income"),
  };
}

async function removeLedgerCategory(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const name = normalizeLedgerCategoryName(event.name);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  if (!name) {
    return { success: false, errMsg: "缺少分类名" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }

  await migrateLedgerCategoriesIfNeeded(ledgerId);
  const rowCtx = await fetchLedgerById(ledgerId);
  const listCtx = getLedgerCategoriesList(rowCtx);
  if (!listCtx.includes(name)) {
    return { success: false, errMsg: "该分类不存在" };
  }

  const targetIds = await fetchLedgerIdsForMemberOpenid(openid);

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    const list = getLedgerCategoriesList(row);
    if (!list.includes(name)) {
      continue;
    }
    if (list.length <= 1) {
      return {
        success: false,
        errMsg:
          "部分账本仅剩该分类，无法在所有账本中删除，请先为对应账本添加其他分类",
      };
    }
  }

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    let list = getLedgerCategoriesList(row);
    if (!list.includes(name)) {
      continue;
    }
    if (list.length <= 1) {
      continue;
    }
    list = list.filter((x) => x !== name);
    const m = readLedgerCategoryByFlow(row);
    if (m[name] != null) {
      delete m[name];
    }
    try {
      await db.collection("ledgers").doc(id).update({
        data: { categories: list, categoryByFlow: m },
      });
    } catch (e) {
      return { success: false, errMsg: "删除失败，请重试" };
    }
  }

  const list = await buildCategoryListForLedger(ledgerId);
  const le = await fetchLedgerById(ledgerId);
  return {
    success: true,
    list,
    expenseList: filterCategoriesByKind(list, le, "expense"),
    incomeList: filterCategoriesByKind(list, le, "income"),
  };
}

async function fetchLedgerTransactionsForList(ledgerId) {
  const id = normalizeLedgerId(ledgerId);
  if (!id) {
    return [];
  }
  let rows = null;
  try {
    const res = await db
      .collection("transactions")
      .where({ ledgerId: id })
      .orderBy("createdAt", "desc")
      .limit(LEDGER_TX_LIST_MAX)
      .get();
    rows = res.data || [];
  } catch (e) {
    rows = null;
  }
  if (rows === null) {
    rows = [];
    let skip = 0;
    while (true) {
      const res = await db
        .collection("transactions")
        .where({ ledgerId: id })
        .skip(skip)
        .limit(LEDGER_TX_QUERY_BATCH)
        .get();
      const batch = res.data || [];
      if (!batch.length) {
        break;
      }
      rows.push(...batch);
      if (batch.length < LEDGER_TX_QUERY_BATCH) {
        break;
      }
      skip += batch.length;
    }
  }
  rows.sort((a, b) => txTimeMs(b) - txTimeMs(a));
  if (rows.length > LEDGER_TX_LIST_MAX) {
    return rows.slice(0, LEDGER_TX_LIST_MAX);
  }
  return rows;
}

async function listTransactions(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const ledger = gate.ledger;
  const rows = await fetchLedgerTransactionsForList(ledgerId);
  const profileMap = await fetchProfileMapByOpenids(
    rows.map((tx) => String(tx.createdByOpenid || "").trim()).filter(Boolean)
  );
  const list = rows.map((tx) => {
    const oid = String(tx.createdByOpenid || "").trim();
    const profile = oid ? profileMap[oid] : null;
    return {
      ...tx,
      payerName:
        oid && profile && profile.nickName
          ? profile.nickName
          : oid
            ? maskOpenidForDisplay(oid)
            : "未知",
      payerAvatarUrl: oid && profile ? profile.avatarUrl || "" : "",
      canEdit:
        !isLedgerArchived(ledger) &&
        transactionEditableByCaller(openid, tx, ledger),
    };
  });
  const txTotalCount = await countLedgerTransactions(ledgerId);
  const txListTruncated = txTotalCount > LEDGER_TX_LIST_MAX;
  return {
    success: true,
    list,
    txTotalCount,
    txListTruncated,
    txListTruncatedHint: txListTruncated ? buildTxListTruncatedHint(txTotalCount) : "",
  };
}

async function insertLedgerTransaction(openid, ledgerId, payload) {
  const { amountCents, category, note } = payload;
  const flow = payload.flow === "income" ? "income" : "expense";
  const n = Number(amountCents);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { ok: false, errMsg: "金额不合法" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { ok: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { ok: false, errMsg: active.errMsg };
  }
  const catCheck = await assertCategoryAllowedForLedgerWithFlow(
    ledgerId,
    category,
    flow
  );
  if (!catCheck.ok) {
    return { ok: false, errMsg: catCheck.errMsg };
  }
  const bookedAt =
    payload.bookedAt instanceof Date && !Number.isNaN(payload.bookedAt.getTime())
      ? payload.bookedAt
      : null;
  const row = {
    ledgerId,
    amountCents: n,
    flow,
    category: catCheck.category,
    note: note ? String(note).slice(0, 200) : "",
    createdByOpenid: openid,
    createdAt: db.serverDate(),
  };
  if (bookedAt) {
    row.bookedAt = bookedAt;
  }
  if (payload.assetAccountId != null && String(payload.assetAccountId).trim() !== "") {
    const link = await normalizeOptionalAssetLink(openid, payload.assetAccountId);
    if (!link.ok) {
      return { ok: false, errMsg: link.errMsg || "资产账户无效" };
    }
    if (!link.clear) {
      row.assetAccountId = link.assetAccountId;
      row.assetAccountName = link.assetAccountName;
    }
  }
  if (row.assetAccountId) {
    const aAcc = await getAssetAccountById(
      openid,
      String(row.assetAccountId).trim()
    );
    if (!aAcc) {
      return { ok: false, errMsg: "资产账户不存在" };
    }
    const tForVal =
      row.bookedAt != null ? row.bookedAt : new Date();
    const tChk = assertBookedAtNotBeforeAccountOpen(
      aAcc,
      tForVal,
      "关联资产时，记账时间不能早于该账户的创建时间"
    );
    if (!tChk.ok) {
      return { ok: false, errMsg: tChk.errMsg };
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "attachments")) {
    const att = normalizeTxAttachments(payload.attachments);
    if (!att.ok) {
      return { ok: false, errMsg: att.errMsg };
    }
    if (att.list.length) {
      row.attachments = att.list;
    }
  }
  const addRes = await db.collection("transactions").add({
    data: row,
  });
  return { ok: true, txId: addRes && addRes._id ? addRes._id : "" };
}

async function addTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  let bookedAt = null;
  if (event.bookedAtMs != null) {
    bookedAt = parseClientBookedAtDate(event);
    if (!bookedAt) {
      return { success: false, errMsg: "记账时间不合法" };
    }
  }
  const hasAssetInput =
    event.assetAccountId != null && String(event.assetAccountId).trim() !== "";
  const insPayload = {
    amountCents: event.amountCents,
    flow: event.flow,
    category: event.category,
    note: event.note,
    bookedAt,
    assetAccountId: event.assetAccountId,
  };
  if (Object.prototype.hasOwnProperty.call(event, "attachments")) {
    insPayload.attachments = event.attachments;
  }
  const ins = await insertLedgerTransaction(openid, ledgerId, insPayload);
  if (!ins.ok) {
    return { success: false, errMsg: ins.errMsg };
  }
  if (hasAssetInput && ins.txId) {
    const a = await applyLedgerCreateAssetLink(openid, ledgerId, ins.txId);
    if (!a.ok) {
      try {
        await db.collection("transactions").doc(String(ins.txId).trim()).remove();
      } catch (e) {
        // ignore
      }
      return { success: false, errMsg: a.errMsg || "资产侧记账失败" };
    }
  }
  return { success: true };
}

function parseAmountCentsFromEvent(ev) {
  if (ev.amountCents != null && Number.isFinite(Number(ev.amountCents))) {
    const n = Math.round(Number(ev.amountCents));
    if (n > 0) {
      return n;
    }
  }
  const s = String(ev.amountYuan || ev.amount || "").trim();
  const y = parseFloat(s.replace(/,/g, ""));
  if (!Number.isFinite(y) || y <= 0) {
    return NaN;
  }
  return Math.round(y * 100);
}

function formatNextRunChinaText(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const { y, m, d } = scheduleLib.getChinaYMDHM(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

function recurrenceLabel(rec, row) {
  const wdLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  if (rec === "once") {
    return "一次性";
  }
  if (rec === "daily") {
    const di = scheduleLib.normalizeDayInterval(row && row.dayInterval);
    return di === 1 ? "天" : `每${di}天`;
  }
  if (rec === "weekly") {
    const wi = scheduleLib.normalizeWeekInterval(row && row.weekInterval);
    const wd =
      row && row.weekday != null ? (((Number(row.weekday) || 0) % 7) + 7) % 7 : NaN;
    const intervalText = wi === 1 ? "每" : wi === 2 ? "每二" : "每三";
    if (Number.isFinite(wd) && wd >= 0 && wd <= 6) {
      return `${intervalText}周${wdLabels[wd]}`;
    }
    return wi === 1 ? "周" : wi === 2 ? "每二周" : "每三周";
  }
  if (rec === "monthly") {
    const mi = scheduleLib.normalizeMonthInterval(row && row.monthInterval);
    const md = row && row.monthDay != null ? Number(row.monthDay) : NaN;
    if (mi === 1 && md >= 1 && md <= 28) {
      return `月${md}日`;
    }
    if (md >= 1 && md <= 28) {
      return `每${mi}个月${md}日`;
    }
    return mi === 1 ? "月" : `每${mi}个月`;
  }
  if (rec === "semi_monthly") {
    return "每半月（1日、15日）";
  }
  if (rec === "yearly") {
    const m = row && row.yearMonth != null ? Number(row.yearMonth) : NaN;
    const d = row && row.yearDay != null ? Number(row.yearDay) : NaN;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 28) {
      return `年${m}月${d}日`;
    }
    return "年";
  }
  return rec;
}

function formatScheduleRow(r, ledgerName) {
  const nextMs = scheduleLib.readFirestoreDateMs(r.nextRunAt);
  const nextText =
    Number.isFinite(nextMs) && r.status === "active" && r.enabled !== false
      ? formatNextRunChinaText(nextMs)
      : r.status === "completed"
      ? "已完成"
      : r.enabled === false
      ? "已暂停"
      : "-";
  return {
    _id: r._id,
    ledgerId: r.ledgerId,
    ledgerName: ledgerName || r.ledgerNameSnapshot || "账本",
    amountCents: r.amountCents,
    amountYuan: ((Number(r.amountCents) || 0) / 100).toFixed(2),
    flow: r.flow === "income" ? "income" : "expense",
    category: r.category,
    note: r.note || "",
    assetAccountName: r.assetAccountName ? String(r.assetAccountName).slice(0, 64) : "",
    recurrence: r.recurrence,
    recurrenceText: recurrenceLabel(r.recurrence, r),
    dayInterval: r.dayInterval,
    hour: r.hour,
    minute: r.minute,
    weekday: r.weekday,
    weekInterval: r.weekInterval,
    monthDay: r.monthDay,
    monthInterval: r.monthInterval,
    yearMonth: r.yearMonth,
    yearDay: r.yearDay,
    onceDate: r.onceDate || "",
    enabled: r.enabled !== false,
    status: r.status || "active",
    nextRunAtText: nextText,
    lastError: r.lastError || "",
  };
}

async function listMySchedules(openid) {
  const res = await db
    .collection("ledger_schedules")
    .where({ ownerOpenid: openid })
    .limit(100)
    .get();
  const rows = (res.data || []).slice().sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  const ids = [...new Set(rows.map((row) => row.ledgerId).filter(Boolean))];
  const nameById = {};
  for (let i = 0; i < ids.length; i += 1) {
    const L = await fetchLedgerById(ids[i]);
    if (L && L.name) {
      nameById[ids[i]] = L.name;
    }
  }
  const list = rows.map((r) => formatScheduleRow(r, nameById[r.ledgerId]));
  return { success: true, list };
}

async function getSchedule(openid, event) {
  const sid = event.scheduleId == null ? "" : String(event.scheduleId).trim();
  if (!sid) {
    return { success: false, errMsg: "缺少 scheduleId" };
  }
  let doc;
  try {
    const g = await db.collection("ledger_schedules").doc(sid).get();
    doc = g.data;
  } catch (e) {
    doc = null;
  }
  if (!doc || doc.ownerOpenid !== openid) {
    return { success: false, errMsg: "记录不存在或无权访问" };
  }
  const L = await fetchLedgerById(doc.ledgerId);
  return {
    success: true,
    schedule: formatScheduleRow(doc, L && L.name),
    raw: {
      recurrence: doc.recurrence,
      hour: doc.hour,
      minute: doc.minute,
      dayInterval: doc.dayInterval,
      weekday: doc.weekday,
      weekInterval: doc.weekInterval,
      monthDay: doc.monthDay,
      monthInterval: doc.monthInterval,
      yearMonth: doc.yearMonth,
      yearDay: doc.yearDay,
      onceDate: doc.onceDate || "",
      ledgerId: doc.ledgerId,
      amountYuan: ((Number(doc.amountCents) || 0) / 100).toFixed(2),
      category: doc.category,
      note: doc.note || "",
      flow: doc.flow === "income" ? "income" : "expense",
      enabled: doc.enabled !== false,
      status: doc.status || "active",
      assetAccountId: doc.assetAccountId ? String(doc.assetAccountId) : "",
      assetAccountName: doc.assetAccountName ? String(doc.assetAccountName) : "",
    },
  };
}

async function createSchedule(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const cnt = await db
    .collection("ledger_schedules")
    .where({ ownerOpenid: openid })
    .count();
  const total = (cnt && cnt.total) || 0;
  if (total >= MAX_SCHEDULES_PER_USER) {
    return {
      success: false,
      errMsg: `每人最多 ${MAX_SCHEDULES_PER_USER} 条定时记账`,
    };
  }
  const amountCents = parseAmountCentsFromEvent(event);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { success: false, errMsg: "请输入有效金额" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const recurrence = scheduleLib.normalizeRecurrence(event.recurrence);
  const flow = event.flow === "income" ? "income" : "expense";
  const catCheck = await assertCategoryAllowedForLedgerWithFlow(
    ledgerId,
    event.category,
    flow
  );
  if (!catCheck.ok) {
    return { success: false, errMsg: catCheck.errMsg };
  }
  const note = event.note != null ? String(event.note).slice(0, 200) : "";
  let onceY;
  let onceM;
  let onceD;
  if (recurrence === "once") {
    const parsed = scheduleLib.parseOnceDate(event.onceDate);
    if (!parsed) {
      return { success: false, errMsg: "请选择执行日期（YYYY-MM-DD）" };
    }
    onceY = parsed.onceYear;
    onceM = parsed.onceMonth;
    onceD = parsed.onceDay;
  }
  const comp = scheduleLib.computeInitialNextRun({
    recurrence,
    nowMs: Date.now(),
    weekday: event.weekday,
    monthDay: event.monthDay,
    yearMonth: event.yearMonth,
    yearDay: event.yearDay,
    weekInterval: event.weekInterval,
    monthInterval: event.monthInterval,
    dayInterval: event.dayInterval,
    onceYear: onceY,
    onceMonth: onceM,
    onceDay: onceD,
  });
  if (!comp.ok) {
    return { success: false, errMsg: comp.errMsg };
  }
  let scheduleAssetId = "";
  let scheduleAssetName = "";
  if (event.assetAccountId != null && String(event.assetAccountId).trim() !== "") {
    const link = await normalizeOptionalAssetLink(openid, event.assetAccountId);
    if (!link.ok) {
      return { success: false, errMsg: link.errMsg || "资产账户无效" };
    }
    if (!link.clear) {
      scheduleAssetId = link.assetAccountId;
      scheduleAssetName = link.assetAccountName;
    }
  }
  const scheduleRow = {
      ownerOpenid: openid,
      ledgerId,
      amountCents,
      flow,
      category: catCheck.category,
      note,
      recurrence,
      hour: 0,
      minute: 0,
      dayInterval:
        recurrence === "daily"
          ? scheduleLib.normalizeDayInterval(event.dayInterval)
          : null,
      weekday:
        recurrence === "weekly"
          ? (((Number(event.weekday) || 0) % 7) + 7) % 7
          : null,
      weekInterval:
        recurrence === "weekly"
          ? scheduleLib.normalizeWeekInterval(event.weekInterval)
          : null,
      monthDay:
        recurrence === "monthly"
          ? Math.min(28, Math.max(1, Number(event.monthDay) || 1))
          : null,
      monthInterval:
        recurrence === "monthly"
          ? scheduleLib.normalizeMonthInterval(event.monthInterval)
          : null,
      yearMonth:
        recurrence === "yearly"
          ? Math.min(12, Math.max(1, Number(event.yearMonth) || 1))
          : null,
      yearDay:
        recurrence === "yearly"
          ? Math.min(28, Math.max(1, Number(event.yearDay) || 1))
          : null,
      onceDate:
        recurrence === "once"
          ? String(event.onceDate || "").trim().slice(0, 12)
          : "",
      nextRunAt: new Date(comp.nextRunAtMs),
      enabled: true,
      status: "active",
      ledgerNameSnapshot: gate.ledger.name || "",
      createdAt: db.serverDate(),
      lastRunAt: null,
      lastError: "",
  };
  if (scheduleAssetId) {
    scheduleRow.assetAccountId = scheduleAssetId;
    scheduleRow.assetAccountName = scheduleAssetName;
  }
  const addRes = await db.collection("ledger_schedules").add({
    data: scheduleRow,
  });
  if (addRes && addRes._id) {
    await flushScheduleIfDueNowById(addRes._id);
  }
  return { success: true };
}

async function updateSchedule(openid, event) {
  const sid = event.scheduleId == null ? "" : String(event.scheduleId).trim();
  if (!sid) {
    return { success: false, errMsg: "缺少 scheduleId" };
  }
  let doc;
  try {
    const g = await db.collection("ledger_schedules").doc(sid).get();
    doc = g.data;
  } catch (e) {
    doc = null;
  }
  if (!doc || doc.ownerOpenid !== openid) {
    return { success: false, errMsg: "记录不存在或无权访问" };
  }
  const ledgerGate = await assertMember(openid, doc.ledgerId);
  if (!ledgerGate.ok) {
    return { success: false, errMsg: ledgerGate.errMsg };
  }
  const activeLedger = assertLedgerNotArchived(ledgerGate.ledger);
  if (!activeLedger.ok) {
    return { success: false, errMsg: activeLedger.errMsg };
  }
  const patch = {};
  let effectiveLedgerId = doc.ledgerId;
  if (event.ledgerId != null && String(event.ledgerId).trim()) {
    const nl = normalizeLedgerId(event.ledgerId);
    if (nl && nl !== doc.ledgerId) {
      const g2 = await assertMember(openid, nl);
      if (!g2.ok) {
        return { success: false, errMsg: g2.errMsg };
      }
      const activeTarget = assertLedgerNotArchived(g2.ledger);
      if (!activeTarget.ok) {
        return { success: false, errMsg: activeTarget.errMsg };
      }
      patch.ledgerId = nl;
      patch.ledgerNameSnapshot = g2.ledger.name || "";
      effectiveLedgerId = nl;
    }
  }
  if (event.enabled === false || event.enabled === true) {
    patch.enabled = !!event.enabled;
  }
  if (event.amountYuan != null || event.amountCents != null) {
    const n = parseAmountCentsFromEvent(event);
    if (!Number.isFinite(n) || n <= 0) {
      return { success: false, errMsg: "金额不合法" };
    }
    patch.amountCents = n;
  }
  if (event.category != null) {
    const effFlow =
      event.flow === "income" || event.flow === "expense"
        ? event.flow
        : doc.flow === "income"
          ? "income"
          : "expense";
    const catCheck = await assertCategoryAllowedForLedgerWithFlow(
      effectiveLedgerId,
      event.category,
      effFlow
    );
    if (!catCheck.ok) {
      return { success: false, errMsg: catCheck.errMsg };
    }
    patch.category = catCheck.category;
  }
  if (event.note != null) {
    patch.note = String(event.note).slice(0, 200);
  }
  if (event.flow === "income" || event.flow === "expense") {
    patch.flow = event.flow;
  }
  if (
    event.category == null &&
    (event.flow === "income" || event.flow === "expense")
  ) {
    const c = await assertCategoryAllowedForLedgerWithFlow(
      effectiveLedgerId,
      doc.category || "其他",
      event.flow
    );
    if (!c.ok) {
      return { success: false, errMsg: c.errMsg };
    }
  }
  if (event.rebuildTiming) {
    const recurrence = scheduleLib.normalizeRecurrence(
      event.recurrence || doc.recurrence
    );
    let onceY;
    let onceM;
    let onceD;
    if (recurrence === "once") {
      const parsed = scheduleLib.parseOnceDate(
        event.onceDate || doc.onceDate || ""
      );
      if (!parsed) {
        return { success: false, errMsg: "请选择执行日期" };
      }
      onceY = parsed.onceYear;
      onceM = parsed.onceMonth;
      onceD = parsed.onceDay;
    }
    const comp = scheduleLib.computeInitialNextRun({
      recurrence,
      nowMs: Date.now(),
      weekday: event.weekday != null ? event.weekday : doc.weekday,
      monthDay: event.monthDay != null ? event.monthDay : doc.monthDay,
      yearMonth: event.yearMonth != null ? event.yearMonth : doc.yearMonth,
      yearDay: event.yearDay != null ? event.yearDay : doc.yearDay,
      weekInterval:
        event.weekInterval != null ? event.weekInterval : doc.weekInterval,
      monthInterval:
        event.monthInterval != null ? event.monthInterval : doc.monthInterval,
      dayInterval:
        event.dayInterval != null ? event.dayInterval : doc.dayInterval,
      onceYear: onceY,
      onceMonth: onceM,
      onceDay: onceD,
    });
    if (!comp.ok) {
      return { success: false, errMsg: comp.errMsg };
    }
    patch.recurrence = recurrence;
    patch.hour = 0;
    patch.minute = 0;
    patch.nextRunAt = new Date(comp.nextRunAtMs);
    patch.dayInterval =
      recurrence === "daily"
        ? scheduleLib.normalizeDayInterval(
            event.dayInterval != null ? event.dayInterval : doc.dayInterval
          )
        : null;
    patch.weekday =
      recurrence === "weekly"
        ? (((Number(event.weekday != null ? event.weekday : doc.weekday) ||
            0) %
            7) +
            7) %
          7
        : null;
    patch.weekInterval =
      recurrence === "weekly"
        ? scheduleLib.normalizeWeekInterval(
            event.weekInterval != null ? event.weekInterval : doc.weekInterval
          )
        : null;
    patch.monthDay =
      recurrence === "monthly"
        ? Math.min(
            28,
            Math.max(1, Number(event.monthDay != null ? event.monthDay : doc.monthDay) || 1)
          )
        : null;
    patch.monthInterval =
      recurrence === "monthly"
        ? scheduleLib.normalizeMonthInterval(
            event.monthInterval != null ? event.monthInterval : doc.monthInterval
          )
        : null;
    patch.yearMonth =
      recurrence === "yearly"
        ? Math.min(
            12,
            Math.max(
              1,
              Number(event.yearMonth != null ? event.yearMonth : doc.yearMonth) || 1
            )
          )
        : null;
    patch.yearDay =
      recurrence === "yearly"
        ? Math.min(
            28,
            Math.max(1, Number(event.yearDay != null ? event.yearDay : doc.yearDay) || 1)
          )
        : null;
    patch.onceDate =
      recurrence === "once"
        ? String(event.onceDate || doc.onceDate || "").trim().slice(0, 12)
        : "";
    if (recurrence === "once") {
      patch.status = "active";
    }
    patch.lastError = "";
  }
  if (Object.prototype.hasOwnProperty.call(event, "assetAccountId")) {
    const rawA = event.assetAccountId;
    const trimmed = rawA == null ? "" : String(rawA).trim();
    if (trimmed === "") {
      patch.assetAccountId = _.remove();
      patch.assetAccountName = _.remove();
    } else {
      const link = await normalizeOptionalAssetLink(openid, trimmed);
      if (!link.ok) {
        return { success: false, errMsg: link.errMsg || "资产账户无效" };
      }
      if (!link.clear) {
        patch.assetAccountId = link.assetAccountId;
        patch.assetAccountName = link.assetAccountName;
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    return { success: false, errMsg: "没有要更新的内容" };
  }
  await db.collection("ledger_schedules").doc(sid).update({ data: patch });
  if (patch.nextRunAt != null) {
    await flushScheduleIfDueNowById(sid);
  }
  return { success: true };
}

async function deleteSchedule(openid, event) {
  const sid = event.scheduleId == null ? "" : String(event.scheduleId).trim();
  if (!sid) {
    return { success: false, errMsg: "缺少 scheduleId" };
  }
  let doc;
  try {
    const g = await db.collection("ledger_schedules").doc(sid).get();
    doc = g.data;
  } catch (e) {
    doc = null;
  }
  if (!doc || doc.ownerOpenid !== openid) {
    return { success: false, errMsg: "记录不存在或无权访问" };
  }
  await db.collection("ledger_schedules").doc(sid).remove();
  return { success: true };
}

async function executeScheduleDoc(doc) {
  const id = doc._id;
  const owner = doc.ownerOpenid;
  const ledgerId = doc.ledgerId;
  const gate = await assertMember(owner, ledgerId);
  if (!gate.ok) {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          enabled: false,
          lastError: gate.errMsg,
          lastAttemptAt: db.serverDate(),
        },
      });
    return false;
  }
  const active = assertLedgerNotArchived(gate.ledger);
  if (!active.ok) {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          enabled: false,
          lastError: active.errMsg,
          lastAttemptAt: db.serverDate(),
        },
      });
    return false;
  }
  const baseNote = doc.note ? String(doc.note).trim() : "";
  const noteForTx = baseNote
    ? `[定时] ${baseNote}`.slice(0, 200)
    : "[定时]";
  const hasAssetInput =
    doc.assetAccountId != null && String(doc.assetAccountId).trim() !== "";
  const ins = await insertLedgerTransaction(owner, ledgerId, {
    amountCents: doc.amountCents,
    flow: doc.flow,
    category: doc.category,
    note: noteForTx,
    assetAccountId: doc.assetAccountId,
  });
  if (!ins.ok) {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          lastError: ins.errMsg,
          lastAttemptAt: db.serverDate(),
        },
      });
    return false;
  }
  if (hasAssetInput && ins.txId) {
    const a = await applyLedgerCreateAssetLink(owner, ledgerId, ins.txId, {
      noteVerb: "定时记账",
      sourceChangeSummary: "定时记账",
    });
    if (!a.ok) {
      try {
        await db.collection("transactions").doc(String(ins.txId).trim()).remove();
      } catch (e) {
        // ignore
      }
      await db
        .collection("ledger_schedules")
        .doc(String(id))
        .update({
          data: {
            lastError: a.errMsg || "资产侧记账失败",
            lastAttemptAt: db.serverDate(),
          },
        });
      return false;
    }
  }
  const adv = scheduleLib.advanceAfterRun(doc, Date.now());
  if (adv.done) {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          status: "completed",
          enabled: false,
          lastRunAt: db.serverDate(),
          lastError: "",
        },
      });
  } else {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          nextRunAt: new Date(adv.nextRunAtMs),
          lastRunAt: db.serverDate(),
          lastError: "",
        },
      });
  }
  return true;
}

const SCHEDULE_FLUSH_MAX_STEPS = 8;
const SCHEDULE_DUE_SLACK_MS = 60000;

async function flushScheduleIfDueNowById(scheduleId) {
  const sid = String(scheduleId || "").trim();
  if (!sid) {
    return;
  }
  for (let n = 0; n < SCHEDULE_FLUSH_MAX_STEPS; n += 1) {
    let g;
    try {
      g = await db.collection("ledger_schedules").doc(sid).get();
    } catch (e) {
      break;
    }
    const raw = g.data;
    if (!raw) {
      break;
    }
    const doc = { ...raw, _id: sid };
    if (!doc.enabled || doc.status !== "active") {
      break;
    }
    const t = scheduleLib.readFirestoreDateMs(doc.nextRunAt);
    if (!Number.isFinite(t) || t > Date.now() + SCHEDULE_DUE_SLACK_MS) {
      break;
    }
    await executeScheduleDoc(doc);
  }
}

async function processDueSchedules() {
  const now = new Date();
  let res;
  try {
    res = await db
      .collection("ledger_schedules")
      .where({
        enabled: true,
        status: "active",
        nextRunAt: _.lte(now),
      })
      .limit(80)
      .get();
  } catch (e) {
    const alt = await db.collection("ledger_schedules").limit(200).get();
    const rows = (alt.data || []).filter((d) => {
      if (!d.enabled || d.status !== "active") {
        return false;
      }
      const t = scheduleLib.readFirestoreDateMs(d.nextRunAt);
      return Number.isFinite(t) && t <= now.getTime();
    });
    res = { data: rows.slice(0, 80) };
  }
  const rows = res.data || [];
  let processed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const ok = await executeScheduleDoc(rows[i]);
    if (ok) {
      processed += 1;
    }
  }
  return { ok: true, processed, checked: rows.length };
}

function startOfWeekMonday(d) {
  const p = chinaDateParts(d);
  if (!p) {
    return new Date(0);
  }
  const diff = (p.weekday + 6) % 7;
  const mondayStartMs = chinaDayStartMsByYmd(p.year, p.month, p.day - diff);
  return new Date(mondayStartMs);
}

function endOfWeekFromMonday(mondayStart) {
  const startMs = chinaDayStartMs(mondayStart);
  if (!Number.isFinite(startMs)) {
    return new Date(0);
  }
  return new Date(startMs + DAY_MS * 7 - 1);
}

function formatDateCn(d) {
  const p = chinaDateParts(d);
  if (!p) {
    return "";
  }
  return `${p.year}年${p.month}月${p.day}日`;
}

function toIntInRange(raw, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  const i = Math.floor(n);
  if (i < min || i > max) {
    return null;
  }
  return i;
}

function parseYmdToDate(raw) {
  if (!raw) {
    return null;
  }
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return null;
  }
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mon) || !Number.isFinite(d)) {
    return null;
  }
  if (mon < 1 || mon > 12 || d < 1 || d > 31) {
    return null;
  }
  const dt = new Date(chinaDayStartMsByYmd(y, mon, d));
  if (Number.isNaN(dt.getTime())) {
    return null;
  }
  return dt;
}

function formatYmd(d) {
  const p = chinaDateParts(d);
  if (!p) {
    return "";
  }
  const p2 = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 折线图：仅展示有效时间（账本创建日起，且不超过今天）。 */
function buildAnalyzeTrend(range, start, end, rows, ledgerCreatedMs) {
  const points = [];
  if (!(start instanceof Date) || !(end instanceof Date)) {
    return points;
  }
  const rangeStartMs = start.getTime();
  const rangeEndMs = end.getTime();
  const now = new Date();
  const nowParts = chinaDateParts(now);
  const endOfToday = nowParts
    ? new Date(chinaDayEndMsByYmd(nowParts.year, nowParts.month, nowParts.day))
    : now;
  let createdStartMs = rangeStartMs;
  if (Number.isFinite(Number(ledgerCreatedMs)) && Number(ledgerCreatedMs) > 0) {
    createdStartMs = chinaDayStartMs(Number(ledgerCreatedMs));
  }
  const validStartMs = Math.max(rangeStartMs, createdStartMs);
  const validEndMs = Math.min(rangeEndMs, endOfToday.getTime());
  if (validEndMs < validStartMs) {
    return points;
  }
  if (range === "week" || range === "month") {
    const bucket = {};
    let walkMs = chinaDayStartMs(validStartMs);
    while (walkMs <= validEndMs) {
      bucket[formatYmd(new Date(walkMs))] = { incomeCents: 0, expenseCents: 0 };
      walkMs += DAY_MS;
    }
    for (let i = 0; i < rows.length; i += 1) {
      const dt = txOccurredDate(rows[i]);
      if (!dt) {
        continue;
      }
      const key = formatYmd(dt);
      if (!bucket[key]) {
        continue;
      }
      const tx = rows[i];
      const mag = txMagnitudeCents(tx);
      if (mag <= 0) {
        continue;
      }
      if (normalizeTxFlow(tx) === "income") {
        bucket[key].incomeCents += mag;
      } else {
        bucket[key].expenseCents += mag;
      }
    }
    walkMs = chinaDayStartMs(validStartMs);
    while (walkMs <= validEndMs) {
      const dayDate = new Date(walkMs);
      const key = formatYmd(dayDate);
      const b = bucket[key] || { incomeCents: 0, expenseCents: 0 };
      const p = chinaDateParts(dayDate);
      const x =
        range === "week"
          ? WEEKDAY_CN[p ? p.weekday : 0]
          : `${p ? p.month : 0}/${p ? p.day : 0}`;
      points.push({
        x,
        dateKey: key,
        income: b.incomeCents / 100,
        expense: b.expenseCents / 100,
      });
      walkMs += DAY_MS;
    }
    return points;
  }
  if (range === "year") {
    const startParts = chinaDateParts(start);
    const validStartParts = chinaDateParts(validStartMs);
    const validEndParts = chinaDateParts(validEndMs);
    if (!startParts || !validStartParts || !validEndParts) {
      return points;
    }
    const y = startParts.year;
    if (validStartParts.year !== y || validEndParts.year !== y) {
      return points;
    }
    const monthStart = validStartParts.month;
    const monthEnd = validEndParts.month;
    const bucket = {};
    for (let m = monthStart; m <= monthEnd; m += 1) {
      bucket[m] = { incomeCents: 0, expenseCents: 0 };
    }
    for (let i = 0; i < rows.length; i += 1) {
      const dt = txOccurredDate(rows[i]);
      const p = chinaDateParts(dt);
      if (!p || p.year !== y) {
        continue;
      }
      const m = p.month;
      const tx = rows[i];
      const mag = txMagnitudeCents(tx);
      if (mag <= 0) {
        continue;
      }
      if (normalizeTxFlow(tx) === "income") {
        bucket[m].incomeCents += mag;
      } else {
        bucket[m].expenseCents += mag;
      }
    }
    for (let m = monthStart; m <= monthEnd; m += 1) {
      const b = bucket[m];
      points.push({
        x: `${m}月`,
        dateKey: `m${m}`,
        income: b.incomeCents / 100,
        expense: b.expenseCents / 100,
      });
    }
  }
  return points;
}

function getAnalyzeRange(range, event = {}) {
  const now = new Date();
  const selectedYear = toIntInRange(event.year, 1970, 9999) || now.getFullYear();
  const selectedMonth = toIntInRange(event.month, 1, 12) || now.getMonth() + 1;
  const weekAnchor = parseYmdToDate(event.weekAnchorDate) || now;
  const weekAnchorDate = formatYmd(weekAnchor);
  let start;
  let end;
  let label;
  if (range === "week") {
    start = startOfWeekMonday(weekAnchor);
    end = endOfWeekFromMonday(start);
    label = `${formatDateCn(start)} - ${formatDateCn(end)}`;
  } else if (range === "month") {
    const lastDay = new Date(Date.UTC(selectedYear, selectedMonth, 0)).getUTCDate();
    start = new Date(chinaDayStartMsByYmd(selectedYear, selectedMonth, 1));
    end = new Date(chinaDayEndMsByYmd(selectedYear, selectedMonth, lastDay));
    label = `${selectedYear}年${selectedMonth}月`;
  } else if (range === "year") {
    start = new Date(chinaDayStartMsByYmd(selectedYear, 1, 1));
    end = new Date(chinaDayEndMsByYmd(selectedYear, 12, 31));
    label = `${selectedYear}年`;
  } else {
    start = new Date(0);
    end = now;
    label = "全部";
  }
  return { start, end, label, selectedYear, selectedMonth, weekAnchorDate };
}

function getAnalyzeCompareRange(range, current) {
  const { start, selectedYear, selectedMonth } = current || {};
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    return {
      start: new Date(0),
      end: new Date(0),
      label: "上期",
      compareHint: "较上期",
    };
  }
  if (range === "week") {
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - 7);
    prevStart.setHours(0, 0, 0, 0);
    const prevEnd = endOfWeekFromMonday(prevStart);
    return {
      start: prevStart,
      end: prevEnd,
      label: `${formatDateCn(prevStart)} - ${formatDateCn(prevEnd)}`,
      compareHint: "较上周",
    };
  }
  if (range === "month") {
    const currentYear = Number(selectedYear) || start.getFullYear();
    const currentMonth = Number(selectedMonth) || start.getMonth() + 1;
    const prevMonthDate = new Date(currentYear, currentMonth - 2, 1, 0, 0, 0, 0);
    const p = chinaDateParts(prevMonthDate);
    const y = p ? p.year : prevMonthDate.getFullYear();
    const m = p ? p.month : prevMonthDate.getMonth() + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      start: new Date(chinaDayStartMsByYmd(y, m, 1)),
      end: new Date(chinaDayEndMsByYmd(y, m, lastDay)),
      label: `${y}年${m}月`,
      compareHint: "较上月",
    };
  }
  if (range === "year") {
    const sp = chinaDateParts(start);
    const y = (Number(selectedYear) || (sp ? sp.year : start.getFullYear())) - 1;
    return {
      start: new Date(chinaDayStartMsByYmd(y, 1, 1)),
      end: new Date(chinaDayEndMsByYmd(y, 12, 31)),
      label: `${y}年`,
      compareHint: "较去年",
    };
  }
  return {
    start: new Date(0),
    end: new Date(start),
    label: "上期",
    compareHint: "较上期",
  };
}

function summarizeTxTotals(rows) {
  let totalExpenseCents = 0;
  let totalIncomeCents = 0;
  let netCents = 0;
  let txCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const tx = rows[i];
    const mag = txMagnitudeCents(tx);
    if (mag <= 0) {
      continue;
    }
    txCount += 1;
    const signed = txSignedCents(tx);
    netCents += signed;
    if (normalizeTxFlow(tx) === "income") {
      totalIncomeCents += mag;
    } else {
      totalExpenseCents += mag;
    }
  }
  return { totalExpenseCents, totalIncomeCents, netCents, txCount };
}

function maskOpenidForDisplay(oid) {
  if (!oid || typeof oid !== "string") {
    return "未知";
  }
  if (oid.length <= 8) {
    return oid;
  }
  return `…${oid.slice(-8)}`;
}

/** 流水图片附件上限 */
const TX_ATTACHMENT_MAX = 9;
const TX_ATTACHMENT_NAME_MAX = 80;

function isCloudFileId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  return s.startsWith("cloud://") && s.length >= 12 && s.length <= 512;
}

/**
 * 规范化记一笔图片附件列表。
 * @returns {{ ok: true, list: object[] } | { ok: false, errMsg: string }}
 */
function normalizeTxAttachments(raw) {
  if (raw == null) {
    return { ok: true, list: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, errMsg: "附件格式不正确" };
  }
  if (raw.length > TX_ATTACHMENT_MAX) {
    return { ok: false, errMsg: `最多上传${TX_ATTACHMENT_MAX}张图片` };
  }
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i] || {};
    const fileID = String(item.fileID || item.fileId || "").trim();
    if (!isCloudFileId(fileID)) {
      return { ok: false, errMsg: "图片附件无效" };
    }
    if (seen[fileID]) {
      continue;
    }
    seen[fileID] = true;
    const contentType = String(item.contentType || "").trim().slice(0, 64);
    if (contentType && !/^image\//i.test(contentType)) {
      return { ok: false, errMsg: "仅支持图片附件" };
    }
    const name = String(item.name || "").trim().slice(0, TX_ATTACHMENT_NAME_MAX);
    const sizeNum = Number(item.size);
    const row = { fileID };
    if (name) {
      row.name = name;
    }
    if (Number.isFinite(sizeNum) && sizeNum >= 0) {
      row.size = Math.min(Math.round(sizeNum), 50 * 1024 * 1024);
    }
    if (contentType) {
      row.contentType = contentType;
    }
    out.push(row);
  }
  return { ok: true, list: out };
}

function collectAttachmentFileIds(txOrList) {
  const list = Array.isArray(txOrList)
    ? txOrList
    : Array.isArray(txOrList && txOrList.attachments)
      ? txOrList.attachments
      : [];
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < list.length; i += 1) {
    const id = String((list[i] && (list[i].fileID || list[i].fileId)) || "").trim();
    if (!isCloudFileId(id) || seen[id]) {
      continue;
    }
    seen[id] = true;
    out.push(id);
  }
  return out;
}

/** 尽力删除云存储文件；失败忽略，不阻断流水主流程 */
async function deleteCloudFilesBestEffort(fileIds) {
  const ids = (fileIds || []).filter(isCloudFileId);
  if (!ids.length) {
    return;
  }
  const chunk = ids.slice(0, 50);
  try {
    await cloud.deleteFile({ fileList: chunk });
  } catch (e) {
    // ignore
  }
}

function normalizeNickname(raw) {
  const nick = String(raw == null ? "" : raw).trim().slice(0, 32);
  if (!nick) {
    return "";
  }
  // 微信默认占位昵称（如“微信用户”）不作为有效展示名，回退到匿名 openid。
  if (nick === "微信用户" || /^微信用户\d*$/.test(nick)) {
    return "";
  }
  return nick;
}

function buildProfileDisplayName(openid, nickName) {
  const normalizedNick = normalizeNickname(nickName);
  if (normalizedNick) {
    return normalizedNick;
  }
  return maskOpenidForDisplay(String(openid || "").trim());
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

async function getUserProfile(openid) {
  try {
    const res = await db.collection("user_profiles").doc(openid).get();
    return res && res.data ? res.data : null;
  } catch (e) {
    const msg = e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : String(e);
    if (
      /document\.get:fail|DOCUMENT_NOT_FOUND|does not exist|DOCUMENT_GET/i.test(msg)
    ) {
      return null;
    }
    throw e;
  }
}

function finalizeFlowPieGroups(buckets, groupBy, nicknameMap) {
  const keys = Object.keys(buckets || {});
  if (!keys.length) {
    return [];
  }
  const listRaw = keys.map((k) => {
    const b = buckets[k];
    const labelText =
      groupBy === "person"
        ? k === "未知"
          ? "未知"
          : nicknameMap[k] || maskOpenidForDisplay(k)
        : k;
    return {
      key: k,
      label: labelText,
      amountCents: b.amountCents,
      count: b.count,
    };
  });
  const sumTot = listRaw.reduce((s, g) => s + (Number(g.amountCents) || 0), 0);
  if (sumTot <= 0) {
    return [];
  }
  const list = listRaw.map((g) => {
    const amt = Number(g.amountCents) || 0;
    const pct = Math.round((amt * 1000) / sumTot) / 10;
    return {
      key: g.key,
      label: g.label,
      amountCents: amt,
      amountYuan: (amt / 100).toFixed(2),
      count: g.count,
      percent: pct,
    };
  });
  list.sort((a, b) => b.amountCents - a.amountCents);
  return list;
}

/** 支出排行：amountCents 为支出分（正），占比相对本维度支出合计 */
function buildExpenseRankGroupList(buckets, dimension, identityMap) {
  const keys = Object.keys(buckets || {});
  if (!keys.length) {
    return [];
  }
  const listRaw = keys.map((k) => {
    const b = buckets[k];
    const profile = dimension === "person" && k !== "未知" && identityMap ? identityMap[k] : null;
    const nickText =
      dimension === "person" && k !== "未知"
        ? profile && profile.nickName
          ? profile.nickName
          : maskOpenidForDisplay(k)
        : "";
    const labelText =
      dimension === "person"
        ? k === "未知"
          ? "未知"
          : nickText
        : k;
    return {
      key: k,
      label: labelText,
      avatarUrl:
        dimension === "person" && k !== "未知" && profile ? profile.avatarUrl || "" : "",
      amountCents: b.amountCents,
      count: b.count,
    };
  });
  const sumTot = listRaw.reduce((s, g) => s + (Number(g.amountCents) || 0), 0);
  if (sumTot <= 0) {
    return [];
  }
  const list = listRaw.map((g) => {
    const amt = Number(g.amountCents) || 0;
    const pct = Math.round((amt * 1000) / sumTot) / 10;
    return {
      key: g.key,
      label: g.label,
      avatarUrl: g.avatarUrl || "",
      amountCents: amt,
      amountYuan: (amt / 100).toFixed(2),
      count: g.count,
      percent: pct,
    };
  });
  list.sort((a, b) => b.amountCents - a.amountCents);
  return list;
}

async function fetchNicknameMapByOpenids(openids) {
  const uniq = [...new Set((openids || []).map((x) => String(x || "").trim()).filter(Boolean))];
  const map = {};
  if (!uniq.length) {
    return map;
  }
  const batchSize = 20;
  for (let i = 0; i < uniq.length; i += batchSize) {
    const part = uniq.slice(i, i + batchSize);
    const res = await db
      .collection("user_profiles")
      .where({ openid: _.in(part) })
      .field({ openid: true, nickName: true })
      .get();
    const rows = res.data || [];
    for (let j = 0; j < rows.length; j += 1) {
      const r = rows[j];
      const oid = String(r.openid || "").trim();
      const nick = normalizeNickname(r.nickName);
      if (oid && nick) {
        map[oid] = nick;
      }
    }
  }
  return map;
}

async function fetchProfileMapByOpenids(openids) {
  const uniq = [...new Set((openids || []).map((x) => String(x || "").trim()).filter(Boolean))];
  const map = {};
  if (!uniq.length) {
    return map;
  }
  const batchSize = 20;
  for (let i = 0; i < uniq.length; i += batchSize) {
    const part = uniq.slice(i, i + batchSize);
    const res = await db
      .collection("user_profiles")
      .where({ openid: _.in(part) })
      .field({ openid: true, nickName: true, avatarUrl: true })
      .get();
    const rows = res.data || [];
    for (let j = 0; j < rows.length; j += 1) {
      const r = rows[j];
      const oid = String(r.openid || "").trim();
      if (!oid) {
        continue;
      }
      map[oid] = {
        nickName: normalizeNickname(r.nickName),
        avatarUrl: normalizeAvatarUrl(r.avatarUrl),
      };
    }
  }
  return map;
}

function ownerProfileFieldsFromMap(profileMap, ownerOpenid) {
  const owner = String(ownerOpenid || "").trim();
  if (!owner) {
    return { ownerNickname: "", ownerAvatarUrl: "" };
  }
  const p = (profileMap && profileMap[owner]) || {};
  return {
    ownerNickname: p.nickName || maskOpenidForDisplay(owner),
    ownerAvatarUrl: p.avatarUrl || "",
  };
}

async function attachOutboundShareMemberCounts(ownerOpenid, rows) {
  const owner = String(ownerOpenid || "").trim();
  const list = Array.isArray(rows) ? rows : [];
  if (!owner || !list.length) {
    return list;
  }
  const hasOwnedRow = list.some((row) => {
    if (String(row.ownerOpenid || "").trim() !== owner) {
      return false;
    }
    return String(row.shareRole || "").trim() !== "viewer";
  });
  if (!hasOwnedRow) {
    return list;
  }
  const shareRes = await db
    .collection("asset_account_shares")
    .where({ ownerOpenid: owner, status: "active" })
    .limit(500)
    .get();
  const countByAccountId = {};
  (shareRes.data || []).forEach((row) => {
    const aid = String(row.accountId || "").trim();
    if (!aid) {
      return;
    }
    countByAccountId[aid] = (countByAccountId[aid] || 0) + 1;
  });
  return list.map((row) => {
    if (String(row.ownerOpenid || "").trim() !== owner) {
      return row;
    }
    if (String(row.shareRole || "").trim() === "viewer") {
      return row;
    }
    const aid = String(row._id || "").trim();
    const shareMemberCount = aid ? countByAccountId[aid] || 0 : 0;
    if (!shareMemberCount) {
      return row;
    }
    return { ...row, shareMemberCount };
  });
}

async function attachOwnerProfilesToAssetRows(rows) {
  const ownerIds = [
    ...new Set((rows || []).map((r) => String(r.ownerOpenid || "").trim()).filter(Boolean)),
  ];
  const profileMap = await fetchProfileMapByOpenids(ownerIds);
  return (rows || []).map((row) => {
    const owner = String(row.ownerOpenid || "").trim();
    const fields = ownerProfileFieldsFromMap(profileMap, owner);
    return { ...row, ...fields };
  });
}

function buildGroupedSharedAssetAccounts(rows) {
  const groupedMap = {};
  (rows || []).forEach((row) => {
    const owner = String(row.ownerOpenid || "").trim();
    if (!owner) {
      return;
    }
    if (!groupedMap[owner]) {
      groupedMap[owner] = {
        ownerOpenid: owner,
        ownerNickname: row.ownerNickname || maskOpenidForDisplay(owner),
        ownerAvatarUrl: row.ownerAvatarUrl || "",
        accounts: [],
      };
    }
    groupedMap[owner].accounts.push(row);
  });
  return Object.keys(groupedMap)
    .map((k) => groupedMap[k])
    .sort((a, b) => String(a.ownerNickname).localeCompare(String(b.ownerNickname)));
}

async function collectTransactionsForLedgerIds(ledgerIdList) {
  const list = (ledgerIdList || []).map((x) => normalizeLedgerId(x)).filter(Boolean);
  const all = [];
  for (let i = 0; i < list.length; i += 1) {
    const res = await db
      .collection("transactions")
      .where({ ledgerId: list[i] })
      .limit(1000)
      .get();
    all.push(...(res.data || []));
  }
  return all;
}

function normalizeLedgerIdsFromEvent(event) {
  const raw = event && event.ledgerIds;
  if (!raw) {
    return [];
  }
  const arr = Array.isArray(raw) ? raw : [raw];
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const id = normalizeLedgerId(arr[i]);
    if (!id || seen[id]) {
      continue;
    }
    seen[id] = true;
    out.push(id);
  }
  return out;
}

function buildAnalyzeScopeLabel(ledgers) {
  const names = (ledgers || [])
    .map((l) => String((l && l.name) || "未命名账本").trim())
    .filter(Boolean);
  if (!names.length) {
    return "";
  }
  if (names.length === 1) {
    return names[0];
  }
  if (names.length === 2) {
    const joined = `${names[0]} + ${names[1]}`;
    return joined.length > 24 ? "已选 2 个账本" : joined;
  }
  return `已选 ${names.length} 个账本`;
}

function sumMonthlyBudgetCentsForLedgers(ledgers) {
  let sum = 0;
  let any = false;
  for (let i = 0; i < (ledgers || []).length; i += 1) {
    const b = readMonthlyBudgetCents(ledgers[i]);
    if (b && b > 0) {
      sum += b;
      any = true;
    }
  }
  return any ? sum : null;
}

async function resolveAccessibleLedgersForOpenid(openid, ledgerIdList) {
  const list = (ledgerIdList || []).map((x) => normalizeLedgerId(x)).filter(Boolean);
  if (!list.length) {
    return { ok: false, errMsg: "缺少账本" };
  }
  const ledgers = [];
  const ledgerIds = [];
  for (let i = 0; i < list.length; i += 1) {
    const gate = await assertMember(openid, list[i]);
    if (!gate.ok || !gate.ledger) {
      continue;
    }
    if (isLedgerArchived(gate.ledger)) {
      continue;
    }
    ledgers.push(gate.ledger);
    ledgerIds.push(String(gate.ledger._id));
  }
  if (!ledgerIds.length) {
    return { ok: false, errMsg: "暂无可统计账本" };
  }
  return { ok: true, ledgers, ledgerIds };
}

async function buildLedgerIdToDocMapForOpenid(openid) {
  const res = await db
    .collection("ledgers")
    .where({ memberOpenids: openid, archived: _.neq(true) })
    .get();
  const map = Object.create(null);
  const rows = res.data || [];
  for (let i = 0; i < rows.length; i += 1) {
    const d = rows[i];
    if (d && d._id && !isLedgerArchived(d)) {
      map[String(d._id)] = d;
    }
  }
  return map;
}

function minCreatedMsForLedgerDocs(ledgerRows) {
  let minMs = 0;
  for (let i = 0; i < (ledgerRows || []).length; i += 1) {
    const ms = readDateMs(ledgerRows[i] && ledgerRows[i].createdAt);
    if (Number.isFinite(ms) && ms > 0) {
      if (!minMs || ms < minMs) {
        minMs = ms;
      }
    }
  }
  return minMs;
}

/** 全账本统计与分账本复用，不含权限拉数（rows / compareRows 已就绪） */
async function buildAnalyzeLedgerResultPayload(
  _openid,
  {
    range,
    baseRange,
    compareRange,
    rows,
    compareRows,
    ledgerName,
    monthlyBudgetCents,
    trendLedgerMs,
    txDataTruncated,
    txDataTruncatedHint,
  }
) {
  const { start, end, label, selectedYear, selectedMonth, weekAnchorDate } = baseRange;
  const profileMap = await fetchProfileMapByOpenids(
    rows.map((tx) => String(tx.createdByOpenid || "").trim()).filter(Boolean)
  );

  const expenseBucketsCategory = {};
  const expenseBucketsPerson = {};
  const incomeBucketsCategory = {};
  const currentTotals = summarizeTxTotals(rows);
  const compareTotals = summarizeTxTotals(compareRows);
  const { totalExpenseCents, totalIncomeCents, netCents, txCount } = currentTotals;
  for (let i = 0; i < rows.length; i += 1) {
    const tx = rows[i];
    const mag = txMagnitudeCents(tx);
    if (mag <= 0) {
      continue;
    }
    const catKey = tx.category ? String(tx.category) : "其他";
    const personKey = tx.createdByOpenid || "未知";

    if (normalizeTxFlow(tx) === "income") {
      if (!incomeBucketsCategory[catKey]) {
        incomeBucketsCategory[catKey] = { amountCents: 0, count: 0, key: catKey };
      }
      incomeBucketsCategory[catKey].amountCents += mag;
      incomeBucketsCategory[catKey].count += 1;
    } else {
      if (!expenseBucketsCategory[catKey]) {
        expenseBucketsCategory[catKey] = { amountCents: 0, count: 0, key: catKey };
      }
      expenseBucketsCategory[catKey].amountCents += mag;
      expenseBucketsCategory[catKey].count += 1;
      if (!expenseBucketsPerson[personKey]) {
        expenseBucketsPerson[personKey] = { amountCents: 0, count: 0, key: personKey };
      }
      expenseBucketsPerson[personKey].amountCents += mag;
      expenseBucketsPerson[personKey].count += 1;
    }
  }

  const listByCategory = buildExpenseRankGroupList(
    expenseBucketsCategory,
    "category",
    profileMap
  );
  const listByPerson = buildExpenseRankGroupList(
    expenseBucketsPerson,
    "person",
    profileMap
  );

  const pieGroupsExpense = finalizeFlowPieGroups(
    expenseBucketsCategory,
    "category",
    {}
  );
  const pieGroupsIncome = finalizeFlowPieGroups(
    incomeBucketsCategory,
    "category",
    {}
  );

  const trendPoints = buildAnalyzeTrend(range, start, end, rows, trendLedgerMs);

  const budgetCents = monthlyBudgetCents;
  let budgetBarWidth = null;
  let budgetUsedPercent = null;
  let budgetRemainingCents = null;
  let budgetState = null;
  if (range === "month" && budgetCents) {
    budgetBarWidth = Math.min(
      100,
      Math.max(0, Math.round((totalExpenseCents * 100) / budgetCents))
    );
    budgetUsedPercent = Math.min(
      999,
      Math.max(0, Math.round((totalExpenseCents * 100) / budgetCents))
    );
    budgetRemainingCents = budgetCents - totalExpenseCents;
    if (totalExpenseCents > budgetCents) {
      budgetState = "over";
    } else if (totalExpenseCents * 10 >= budgetCents * 9) {
      budgetState = "warn";
    } else {
      budgetState = "ok";
    }
  }

  return {
    success: true,
    ledgerName: ledgerName || "",
    range,
    rangeLabel: label,
    selectedYear,
    selectedMonth,
    weekAnchorDate,
    groupBy: "category",
    totalExpenseCents,
    totalIncomeCents,
    netCents,
    totalExpenseYuan: (totalExpenseCents / 100).toFixed(2),
    totalIncomeYuan: (totalIncomeCents / 100).toFixed(2),
    netYuan: formatSignedYuanFromCents(netCents),
    totalYuan: formatSignedYuanFromCents(netCents),
    monthlyBudgetCents: budgetCents,
    budgetBarWidth,
    budgetUsedPercent,
    budgetRemainingCents,
    budgetState,
    txCount,
    compareHint: compareRange.compareHint,
    compareRangeLabel: compareRange.label,
    compareTotalExpenseCents: compareTotals.totalExpenseCents,
    compareTotalIncomeCents: compareTotals.totalIncomeCents,
    compareNetCents: compareTotals.netCents,
    compareTxCount: compareTotals.txCount,
    compareTotalExpenseYuan: (compareTotals.totalExpenseCents / 100).toFixed(2),
    compareTotalIncomeYuan: (compareTotals.totalIncomeCents / 100).toFixed(2),
    compareNetYuan: formatSignedYuanFromCents(compareTotals.netCents),
    netDeltaCents: netCents - compareTotals.netCents,
    expenseDeltaCents: totalExpenseCents - compareTotals.totalExpenseCents,
    incomeDeltaCents: totalIncomeCents - compareTotals.totalIncomeCents,
    groups: listByCategory,
    groupsByPerson: listByPerson,
    pieGroupsExpense,
    pieGroupsIncome,
    trendPoints,
    txDataTruncated: !!txDataTruncated,
    txDataTruncatedHint: txDataTruncatedHint ? String(txDataTruncatedHint) : "",
  };
}

async function analyzeLedgerForIds(openid, event, ledgerIdList, opts) {
  const options = opts || {};
  const range = event.range === "month" || event.range === "year" ? event.range : "week";
  const baseRange = getAnalyzeRange(range, event);
  const compareRange = getAnalyzeCompareRange(range, baseRange);
  const { start, end } = baseRange;
  const startMs = start.getTime();
  const endMs = end.getTime();
  const compareStartMs = compareRange.start.getTime();
  const compareEndMs = compareRange.end.getTime();

  const resolved = await resolveAccessibleLedgersForOpenid(openid, ledgerIdList);
  if (!resolved.ok) {
    return { success: false, errMsg: resolved.errMsg };
  }
  const { ledgers, ledgerIds } = resolved;

  const truncation = await resolveTxTruncationForLedgers(ledgerIds);
  const all = await collectTransactionsForLedgerIds(ledgerIds);
  const rows = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= startMs && t <= endMs;
  });
  const compareRows = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= compareStartMs && t <= compareEndMs;
  });

  const ledgerName =
    options.ledgerName != null ? options.ledgerName : buildAnalyzeScopeLabel(ledgers);
  const monthlyBudgetCents =
    options.monthlyBudgetCents !== undefined
      ? options.monthlyBudgetCents
      : sumMonthlyBudgetCentsForLedgers(ledgers);
  const trendLedgerMs = minCreatedMsForLedgerDocs(ledgers);

  return buildAnalyzeLedgerResultPayload(openid, {
    range,
    baseRange,
    compareRange,
    rows,
    compareRows,
    ledgerName,
    monthlyBudgetCents,
    trendLedgerMs,
    txDataTruncated: truncation.txDataTruncated,
    txDataTruncatedHint: truncation.txDataTruncatedHint,
  });
}

async function analyzeLedgerAllOpen(openid, event) {
  const ledgerIdList = await fetchLedgerIdsForMemberOpenid(openid);
  if (!ledgerIdList.length) {
    return { success: false, errMsg: "暂无可统计账本" };
  }
  return analyzeLedgerForIds(openid, event, ledgerIdList, {
    ledgerName: "全部账本",
    monthlyBudgetCents: null,
  });
}

async function analyzeLedger(openid, event) {
  if (event.scope === "all" || event.allLedgers === true) {
    return await analyzeLedgerAllOpen(openid, event);
  }
  const customIds = normalizeLedgerIdsFromEvent(event);
  if (customIds.length > 0) {
    return analyzeLedgerForIds(openid, event, customIds);
  }
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const range = event.range === "month" || event.range === "year" ? event.range : "week";

  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }

  const baseRange = getAnalyzeRange(range, event);
  const compareRange = getAnalyzeCompareRange(range, baseRange);
  const { start, end } = baseRange;
  const startMs = start.getTime();
  const endMs = end.getTime();
  const compareStartMs = compareRange.start.getTime();
  const compareEndMs = compareRange.end.getTime();
  const truncation = await resolveTxTruncationForLedgers([ledgerId]);
  const res = await db
    .collection("transactions")
    .where({ ledgerId })
    .limit(1000)
    .get();
  const all = res.data || [];
  const rows = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= startMs && t <= endMs;
  });
  const compareRows = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= compareStartMs && t <= compareEndMs;
  });

  return buildAnalyzeLedgerResultPayload(openid, {
    range,
    baseRange,
    compareRange,
    rows,
    compareRows,
    ledgerName: gate.ledger && gate.ledger.name ? String(gate.ledger.name) : "",
    monthlyBudgetCents: readMonthlyBudgetCents(gate.ledger),
    trendLedgerMs: readDateMs(gate.ledger.createdAt),
    txDataTruncated: truncation.txDataTruncated,
    txDataTruncatedHint: truncation.txDataTruncatedHint,
  });
}

function formatTxLineTime(d) {
  if (!d) {
    return "";
  }
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return formatChinaTimeText(ms);
}

async function listGroupTransactions(openid, event) {
  const scopeAll = event.scope === "all" || event.allLedgers === true;
  const customIds = normalizeLedgerIdsFromEvent(event);
  const scopeCustom = !scopeAll && customIds.length > 0;
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const range = event.range === "month" || event.range === "year" ? event.range : "week";
  const groupBy =
    event.groupBy === "person" || event.groupBy === "category"
      ? event.groupBy
      : "category";
  const subGroupBy = event.subGroupBy === "category" ? "category" : "";
  let groupKey = event.groupKey;
  let subGroupKey = event.subGroupKey;
  if (groupKey != null && typeof groupKey !== "string") {
    groupKey = String(groupKey);
  }
  if (subGroupKey != null && typeof subGroupKey !== "string") {
    subGroupKey = String(subGroupKey);
  }
  if (groupKey == null || groupKey === "") {
    return { success: false, errMsg: "参数不完整" };
  }
  if (!scopeAll && !scopeCustom && !ledgerId) {
    return { success: false, errMsg: "参数不完整" };
  }

  let gate = null;
  let ledgerIdToDoc = null;
  let targetLedgerIds = [];
  if (scopeAll) {
    ledgerIdToDoc = await buildLedgerIdToDocMapForOpenid(openid);
    targetLedgerIds = Object.keys(ledgerIdToDoc);
    if (!targetLedgerIds.length) {
      return { success: false, errMsg: "暂无可统计账本" };
    }
  } else if (scopeCustom) {
    const resolved = await resolveAccessibleLedgersForOpenid(openid, customIds);
    if (!resolved.ok) {
      return { success: false, errMsg: resolved.errMsg };
    }
    ledgerIdToDoc = Object.create(null);
    for (let i = 0; i < resolved.ledgers.length; i += 1) {
      const d = resolved.ledgers[i];
      if (d && d._id) {
        ledgerIdToDoc[String(d._id)] = d;
      }
    }
    targetLedgerIds = resolved.ledgerIds;
  } else {
    const g = await assertMember(openid, ledgerId);
    if (!g.ok) {
      return { success: false, errMsg: g.errMsg };
    }
    gate = g;
  }

  const displayLedgerName = scopeAll
    ? "全部账本"
    : scopeCustom
      ? buildAnalyzeScopeLabel(
          targetLedgerIds.map((id) => ledgerIdToDoc[id]).filter(Boolean)
        )
      : gate.ledger && gate.ledger.name
        ? String(gate.ledger.name)
        : "";

  const { start, end, label, selectedYear, selectedMonth, weekAnchorDate } = getAnalyzeRange(
    range,
    event
  );
  const startMs = start.getTime();
  const endMs = end.getTime();

  const idsForTruncation =
    scopeAll || scopeCustom ? targetLedgerIds : [ledgerId];
  const truncation = await resolveTxTruncationForLedgers(idsForTruncation);

  let all;
  if (scopeAll || scopeCustom) {
    all = await collectTransactionsForLedgerIds(targetLedgerIds);
  } else {
    const res = await db
      .collection("transactions")
      .where({ ledgerId })
      .limit(1000)
      .get();
    all = res.data || [];
  }
  const inRange = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= startMs && t <= endMs;
  });

  const primaryRows = inRange.filter((tx) => {
    const mag = txMagnitudeCents(tx);
    if (mag <= 0) {
      return false;
    }
    if (groupBy === "category") {
      const cat = tx.category ? String(tx.category) : "其他";
      return cat === groupKey;
    }
    const oid = tx.createdByOpenid || "";
    if (groupKey === "未知") {
      return !oid;
    }
    return oid === groupKey;
  });
  const rows = !subGroupBy || !subGroupKey
    ? primaryRows
    : primaryRows.filter((tx) => {
        if (subGroupBy === "category") {
          const cat = tx.category ? String(tx.category) : "其他";
          return cat === subGroupKey;
        }
        return true;
      });

  const openidsForNickname = [...new Set(
    rows
      .map((tx) => String(tx.createdByOpenid || "").trim())
      .filter(Boolean)
      .concat(groupBy === "person" && groupKey !== "未知" ? [groupKey] : [])
  )];
  const profileMap = await fetchProfileMapByOpenids(openidsForNickname);

  rows.sort((a, b) => txTimeMs(b) - txTimeMs(a));

  const primaryGroupTitle =
    groupBy === "person"
      ? groupKey === "未知"
        ? "未知"
        : profileMap[groupKey] && profileMap[groupKey].nickName
          ? profileMap[groupKey].nickName
          : maskOpenidForDisplay(groupKey)
      : groupKey;

  if (groupBy === "person" && subGroupBy === "category" && (!subGroupKey || subGroupKey === "")) {
    const buckets = {};
    for (let i = 0; i < rows.length; i += 1) {
      const tx = rows[i];
      const cat = tx.category ? String(tx.category) : "其他";
      if (!buckets[cat]) {
        buckets[cat] = { amountCents: 0, count: 0, key: cat };
      }
      buckets[cat].amountCents += txSignedCents(tx);
      buckets[cat].count += 1;
    }
    const listRaw = Object.keys(buckets).map((k) => ({
      key: k,
      label: k,
      amountCents: buckets[k].amountCents,
      count: buckets[k].count,
    }));
    const sumAbs = listRaw.reduce(
      (s, g) => s + Math.abs(Number(g.amountCents) || 0),
      0
    );
    const groups = listRaw
      .map((g) => {
        const absAmt = Math.abs(Number(g.amountCents) || 0);
        const pct =
          sumAbs > 0 ? Math.round((absAmt * 1000) / sumAbs) / 10 : 0;
        return {
          key: g.key,
          label: g.label,
          amountCents: g.amountCents,
          amountYuan: formatSignedYuanFromCents(g.amountCents),
          count: g.count,
          percent: pct,
        };
      })
      .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
    return {
      success: true,
      ledgerName: displayLedgerName,
      rangeLabel: label,
      selectedYear,
      selectedMonth,
      weekAnchorDate,
      groupBy,
      groupKey,
      groupTitle: primaryGroupTitle,
      subGroupBy,
      groups,
      txDataTruncated: truncation.txDataTruncated,
      txDataTruncatedHint: truncation.txDataTruncatedHint,
    };
  }

  const list = rows.map((tx) => {
    const oid = String(tx.createdByOpenid || "").trim();
    const profile = oid ? profileMap[oid] : null;
    const payerName =
      oid && profile && profile.nickName
        ? profile.nickName
        : oid
          ? maskOpenidForDisplay(oid)
          : "未知";
    const txLid = String(tx.ledgerId || "").trim();
    const resLedger =
      scopeAll || scopeCustom
        ? ledgerIdToDoc && txLid
          ? ledgerIdToDoc[txLid]
          : null
        : gate && gate.ledger
          ? gate.ledger
          : null;
    const attNorm = normalizeTxAttachments(tx.attachments);
    return {
      _id: tx._id,
      ledgerId: txLid,
      amountYuan: formatSignedYuanFromCents(txSignedCents(tx)),
      flow: normalizeTxFlow(tx),
      category: tx.category ? String(tx.category) : "其他",
      note: tx.note ? String(tx.note) : "",
      timeText: formatTxLineTime(txOccurredDate(tx)),
      payerName,
      payerAvatarUrl: oid && profile ? profile.avatarUrl || "" : "",
      attachments: attNorm.ok ? attNorm.list : [],
      canEdit:
        resLedger &&
        !isLedgerArchived(resLedger) &&
        transactionEditableByCaller(openid, tx, resLedger),
    };
  });

  const groupTitle =
    subGroupBy === "category" && subGroupKey
      ? `${primaryGroupTitle} · ${subGroupKey}`
      : primaryGroupTitle;

  return {
    success: true,
    ledgerName: displayLedgerName,
    rangeLabel: label,
    selectedYear,
    selectedMonth,
    weekAnchorDate,
    groupBy,
    groupKey,
    groupTitle,
    subGroupBy,
    subGroupKey: subGroupKey || "",
    list,
    txDataTruncated: truncation.txDataTruncated,
    txDataTruncatedHint: truncation.txDataTruncatedHint,
  };
}

async function fetchTransactionById(txId) {
  const id = txId == null ? "" : String(txId).trim();
  if (!id) {
    return null;
  }
  try {
    const res = await db
      .collection("transactions")
      .where({ _id: id })
      .limit(1)
      .get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function assertTransactionInLedger(openid, rawLedgerId, txId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { ok: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { ok: false, errMsg: gate.errMsg };
  }
  const tx = await fetchTransactionById(txId);
  if (!tx) {
    return { ok: false, errMsg: "记录不存在" };
  }
  if (normalizeLedgerId(tx.ledgerId) !== ledgerId) {
    return { ok: false, errMsg: "记录不属于该账本" };
  }
  return { ok: true, tx, ledgerId, ledger: gate.ledger };
}

async function getTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const txId = event.txId;
  const g = await assertTransactionInLedger(openid, ledgerId, txId);
  if (!g.ok) {
    return { success: false, errMsg: g.errMsg };
  }
  if (!transactionEditableByCaller(openid, g.tx, g.ledger)) {
    return { success: false, errMsg: "只能编辑或删除本人记录的流水" };
  }
  const tx = g.tx;
  const categories = await buildCategoryListForLedger(ledgerId);
  const le = await fetchLedgerById(ledgerId);
  return {
    success: true,
    categories,
    expenseList: filterCategoriesByKind(categories, le, "expense"),
    incomeList: filterCategoriesByKind(categories, le, "income"),
    transaction: {
      _id: tx._id,
      ledgerId: tx.ledgerId,
      amountCents: Number(tx.amountCents) || 0,
      flow: normalizeTxFlow(tx),
      category: tx.category ? String(tx.category) : "其他",
      note: tx.note ? String(tx.note) : "",
      createdAt: tx.createdAt,
      bookedAt: tx.bookedAt,
      bookedAtMs: txTimeMs(tx),
      assetAccountId: tx.assetAccountId ? String(tx.assetAccountId) : "",
      assetAccountName: tx.assetAccountName ? String(tx.assetAccountName) : "",
      attachments: (() => {
        const att = normalizeTxAttachments(tx.attachments);
        return att.ok ? att.list : [];
      })(),
    },
  };
}

async function updateTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const txId = event.txId;
  const n = Number(event.amountCents);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { success: false, errMsg: "金额不合法" };
  }
  const flow = event.flow === "income" ? "income" : "expense";
  const g = await assertTransactionInLedger(openid, ledgerId, txId);
  if (!g.ok) {
    return { success: false, errMsg: g.errMsg };
  }
  if (!transactionEditableByCaller(openid, g.tx, g.ledger)) {
    return { success: false, errMsg: "只能编辑或删除本人记录的流水" };
  }
  const sourceActive = assertLedgerNotArchived(g.ledger);
  if (!sourceActive.ok) {
    return { success: false, errMsg: sourceActive.errMsg };
  }
  const newLedgerIdRaw =
    event.newLedgerId != null ? normalizeLedgerId(event.newLedgerId) : "";
  const targetLedgerId =
    newLedgerIdRaw && newLedgerIdRaw !== ledgerId ? newLedgerIdRaw : ledgerId;
  if (targetLedgerId !== ledgerId) {
    const targetGate = await assertMember(openid, targetLedgerId);
    if (!targetGate.ok) {
      return { success: false, errMsg: targetGate.errMsg || "无权访问目标账本" };
    }
    const targetActive = assertLedgerNotArchived(targetGate.ledger);
    if (!targetActive.ok) {
      return { success: false, errMsg: targetActive.errMsg };
    }
  }
  const catCheck = await assertCategoryAllowedForLedgerWithFlow(
    targetLedgerId,
    event.category,
    flow
  );
  if (!catCheck.ok) {
    return { success: false, errMsg: catCheck.errMsg };
  }
  const category = catCheck.category;
  const note = event.note != null ? String(event.note).slice(0, 200) : "";
  let bookedAtPatch;
  if (event.bookedAtMs != null) {
    const bd = parseClientBookedAtDate(event);
    if (!bd) {
      return { success: false, errMsg: "记账时间不合法" };
    }
    bookedAtPatch = bd;
  }
  const updateData = {
    amountCents: n,
    flow,
    category,
    note,
  };
  if (targetLedgerId !== ledgerId) {
    updateData.ledgerId = targetLedgerId;
  }
  if (bookedAtPatch) {
    updateData.bookedAt = bookedAtPatch;
  }
  if (Object.prototype.hasOwnProperty.call(event, "assetAccountId")) {
    const rawA = event.assetAccountId;
    const trimmed = rawA == null ? "" : String(rawA).trim();
    if (trimmed === "") {
      updateData.assetAccountId = _.remove();
      updateData.assetAccountName = _.remove();
    } else {
      const link = await normalizeOptionalAssetLink(openid, trimmed);
      if (!link.ok) {
        return { success: false, errMsg: link.errMsg || "资产账户无效" };
      }
      updateData.assetAccountId = link.assetAccountId;
      updateData.assetAccountName = link.assetAccountName;
    }
  }
  let removedAttachmentIds = [];
  if (Object.prototype.hasOwnProperty.call(event, "attachments")) {
    const att = normalizeTxAttachments(event.attachments);
    if (!att.ok) {
      return { success: false, errMsg: att.errMsg };
    }
    const oldIds = collectAttachmentFileIds(g.tx);
    const newIds = collectAttachmentFileIds(att.list);
    const newSet = Object.create(null);
    for (let i = 0; i < newIds.length; i += 1) {
      newSet[newIds[i]] = true;
    }
    removedAttachmentIds = oldIds.filter((id) => !newSet[id]);
    if (att.list.length) {
      updateData.attachments = att.list;
    } else {
      updateData.attachments = _.remove();
    }
  }
  const merged = {
    amountCents: n,
    flow,
    assetAccountId: Object.prototype.hasOwnProperty.call(event, "assetAccountId")
      ? (() => {
          const rawA = event.assetAccountId;
          return rawA == null || String(rawA).trim() === ""
            ? ""
            : String(rawA).trim();
        })()
      : String(g.tx.assetAccountId || "").trim(),
  };
  if (String(merged.assetAccountId || "").trim() !== "") {
    const aAcc2 = await getAssetAccountById(
      openid,
      String(merged.assetAccountId).trim()
    );
    if (!aAcc2) {
      return { success: false, errMsg: "资产账户无效" };
    }
    const eff = { ...g.tx };
    if (bookedAtPatch) {
      eff.bookedAt = bookedAtPatch;
    }
    const tChk = assertBookedAtNotBeforeAccountOpen(
      aAcc2,
      getBookedAtDateForAssetFromTx(eff),
      "记账时间不能早于所选资产账户的创建时间"
    );
    if (!tChk.ok) {
      return { success: false, errMsg: tChk.errMsg };
    }
  }
  const ar = await applyLedgerUpdateAssetSideEffects(
    openid,
    targetLedgerId,
    txId,
    g.tx,
    merged
  );
  if (!ar.ok) {
    return { success: false, errMsg: ar.errMsg || "资产侧处理失败" };
  }
  if (ar.txDataPatch && typeof ar.txDataPatch === "object") {
    const patch = ar.txDataPatch;
    const keys = Object.keys(patch);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      updateData[k] = patch[k];
    }
  }
  try {
    await db
      .collection("transactions")
      .doc(String(txId).trim())
      .update({
        data: {
          ...updateData,
          updatedAt: db.serverDate(),
        },
      });
  } catch (e) {
    return { success: false, errMsg: "更新失败，请重试" };
  }
  if (removedAttachmentIds.length) {
    await deleteCloudFilesBestEffort(removedAttachmentIds);
  }
  return { success: true };
}

async function deleteTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const txId = event.txId;
  const g = await assertTransactionInLedger(openid, ledgerId, txId);
  if (!g.ok) {
    return { success: false, errMsg: g.errMsg };
  }
  if (!transactionEditableByCaller(openid, g.tx, g.ledger)) {
    return { success: false, errMsg: "只能编辑或删除本人记录的流水" };
  }
  const active = assertLedgerNotArchived(g.ledger);
  if (!active.ok) {
    return { success: false, errMsg: active.errMsg };
  }
  const delA = await applyLedgerDeleteAssetLink(openid, ledgerId, g.tx);
  if (!delA.ok) {
    return { success: false, errMsg: delA.errMsg || "资产侧冲销失败" };
  }
  const attachmentIds = collectAttachmentFileIds(g.tx);
  try {
    await db.collection("transactions").doc(String(txId).trim()).remove();
  } catch (e) {
    return { success: false, errMsg: "删除失败，请重试" };
  }
  if (attachmentIds.length) {
    await deleteCloudFilesBestEffort(attachmentIds);
  }
  return { success: true };
}

async function updateMyProfile(openid, event) {
  const payload = event || {};
  const hasNickNameInput = Object.prototype.hasOwnProperty.call(payload, "nickName");
  const rawNickName = String(payload.nickName == null ? "" : payload.nickName).trim().slice(0, 32);
  const incomingNickName = normalizeNickname(rawNickName);
  const incomingAvatarUrl = normalizeAvatarUrl(payload.avatarUrl);
  const profile = await getUserProfile(openid);
  const existingNickName = normalizeNickname(profile && profile.nickName);
  const existingAvatarUrl = normalizeAvatarUrl(profile && profile.avatarUrl);
  const nickName = hasNickNameInput ? incomingNickName : existingNickName;
  if (hasNickNameInput && !nickName) {
    return {
      success: false,
      errMsg: "昵称无效，请填写一个自定义昵称（不要使用“微信用户”）",
    };
  }
  const avatarUrl = incomingAvatarUrl || existingAvatarUrl || "";
  if (!hasNickNameInput && !incomingAvatarUrl) {
    return { success: false, errMsg: "未检测到可更新的资料" };
  }
  await db
    .collection("user_profiles")
    .doc(openid)
    .set({
      data: {
        openid,
        nickName,
        avatarUrl,
        updatedAt: db.serverDate(),
      },
    });
  return {
    success: true,
    profile: {
      nickName,
      avatarUrl,
      displayName: buildProfileDisplayName(openid, nickName),
    },
  };
}

async function getMyProfile(openid) {
  const profile = await getUserProfile(openid);
  if (!profile) {
    return {
      success: true,
      profile: {
        nickName: "",
        avatarUrl: "",
        displayName: buildProfileDisplayName(openid, ""),
      },
    };
  }
  const nickName = normalizeNickname(profile.nickName);
  const avatarUrl = normalizeAvatarUrl(profile.avatarUrl);
  return {
    success: true,
    profile: {
      nickName,
      avatarUrl,
      displayName: buildProfileDisplayName(openid, nickName),
    },
  };
}

