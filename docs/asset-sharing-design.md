# 资产共享功能 — 详细设计

> 状态：**设计稿**（尚未在代码中实现）  
> 基线：当前资产域按 `ownerOpenid` 与调用者 `openid` 一一对应，**无**多用户协作。  
> 目标：在保留既有「仅本人资产」行为的前提下，增加**自愿共享**，被共享方分 **只读（viewer）** 与 **可管理（manager）** 两档。

---

## 1. 背景与目标

### 1.1 问题

- 家庭/小团队需要共同查看或维护同一套资产账户与变动，但当前数据只能归属单一 `openid`。
- 账本侧已有 `ledger_members`、邀请与角色经验，**资产域未复用**该模型。

### 1.2 设计目标

1. **显式共享**：仅通过邀请/接受建立关系，不自动因账本成员而打通资产（避免口径扩散）。
2. **两档权限**：只读可浏览与统计；可管理可执行与现网「户主」一致的**写**操作子集（见 §4）。
3. **户主（Owner）唯一**：数据仍挂在资产所有者的 `ownerOpenid` 下，共享不改变文档归属，仅增加**访问控制**与**上下文**。
4. **可运营、可撤**：支持撤销共享、被共享方主动退出、邀请过期。

### 1.3 非目标（本期不承诺）

- 多「资产空间」/多组独立 portfolio（可预留扩展，见 §12）。
- 与账本权限自动同步（不实现「进账本即自动共享资产」）。
- 行级/字段级脱敏（如对某些账户只读、某些可写）；本期为**全量资产**在两种角色下一致生效。
- 被共享方将共享资产中的记录再「二次共享」给第三人。

---

## 2. 范围定义：共享粒度

**本期采用：按「户主 openid」全量资产共享。**

- 对某一 `ownerOpenid` 建立共享关系后，被共享方在**以该户主为上下文的视图中**可访问其：
  - 全部 `asset_accounts`（含未归档/已归档，与现有 `listAssetAccounts` 入参行为一致，见 API）；
  - 相应 `asset_records`、`asset_snapshots`（净资产趋势等）；
  - 经户主授权后，在「可管理」下执行允许的写入类接口。
- **不**在账户维度单独勾选共享（可列为二期）。

---

## 3. 角色定义


| 角色  | 英文建议      | 说明                                                          |
| --- | --------- | ----------------------------------------------------------- |
| 户主  | `owner`   | 资产在库中的 `ownerOpenid` 与本人 `openid` 一致；唯一可管理成员、邀请、踢人、全量数据归属者。 |
| 只读  | `viewer`  | 仅查询类能力；无写库。                                                 |
| 可管理 | `manager` | 在户主数据域内，允许与现网户主**一致或严格子集**的写能力（见 §4）。                       |


「可管理」**不是**共有人：数据归属不变，审计上仍以户主为数据主体；若需「操作人」审计，可后续在写接口增加 `performedByOpenid` 或沿用现有 `createdBy` 类字段。

---

## 4. 权限矩阵（建议）

**约定**：下表中「现网户主可」指当前代码路径上，**本人 `openid === ownerOpenid`** 时的行为。


| 能力                                   | owner | manager              | viewer |
| ------------------------------------ | ----- | -------------------- | ------ |
| 列表/总览/账户详情/变动列表/单条记录/趋势              | ✓     | ✓                    | ✓      |
| 创建账户、编辑账户、归档/恢复、期初/变动/转账等写操作         | ✓     | ✓（同户主现网，见注 1）        | ✗      |
| 删除无流水账户（`deleteAssetAccount` 现网可能限制） | ✓     | 建议 **仅 owner**       | ✗      |
| 全量重算/快照类运维型接口（若有 `rebuild`*）         | ✓     | 建议 **仅 owner** 或显式开关 | ✗      |
| 邀请、改角色、移除成员、转交户主                     | ✓     | ✗                    | ✗      |
| 主动退出他人共享给自己                          | -     | ✓                    | ✓      |


**注 1（manager 写能力边界）**：实现时建议以**白名单**在 `index.js` 各 `case` 中统一用 `assertAssetAccess(openid, ownerOpenid, requiredRole)` 收敛：  

- `viewer` → 仅只读 `type`；  
- `manager` → 只读 + 允许的 `write` `type`；  
- 禁止 `manager` 调用成员管理类、删除空户（若产品坚持经理可删空户，可放宽并写入本文档定稿版）。

**注 2（与账本联动的记一笔/定时记一笔）**：若流水需关联**户主**名下资产账户，当前为户主本人才可写。扩展后应允许：`openid` 为户主，或 对该 `ownerOpenid` 为 `manager` 且目标账户属该户主。需在 `insertLedgerTransaction` / `appendAssetRecordFromLedger` 等路径增加**按账户反查 `ownerOpenid` + 共享表** 校验，避免越权关链他人账户。

---

## 5. 数据模型

### 5.1 集合 `asset_share_members`（新）

仅云函数读写；小程序不直连，与 `ledger_members` 一致。


| 字段             | 类型              | 说明                                            |
| -------------- | --------------- | --------------------------------------------- |
| `_id`          | string          | 建议 `memberOpenid_ownerOpenid`（唯一、便于按成员查/按户主查） |
| `ownerOpenid`  | string          | 资产户主                                          |
| `memberOpenid` | string          | 被共享方                                          |
| `role`         | string          | `viewer` | `manager`                          |
| `status`       | string          | 建议 `active` | `left`（软删，便于审计）或物理删除 + 操作日志二选一  |
| `joinedAt`     | Date/ServerDate | 生效时间                                          |
| `invitedBy`    | string          | 邀请人 openid（与 owner 通常相同）                      |
| `updatedAt`    | Date            | 可选                                            |


**索引建议**：

- `memberOpenid` + `status`：列出「谁共享给我」。
- `ownerOpenid` + `status`：列出「我共享给谁」。

### 5.2 集合 `asset_share_invites`（新，与账本邀请同构）


| 字段            | 类型     | 说明                                       |
| ------------- | ------ | ---------------------------------------- |
| `_id`         | string | 自生成或 `code` 作键                           |
| `ownerOpenid` | string | 户主                                       |
| `code`        | string | 短码/随机串，如 8 位，与现网 `ledger_invites` 长度策略对齐 |
| `role`        | string | `viewer` | `manager`（受邀者加入后的角色）          |
| `expiresAt`   | Date   | 过期时间                                     |
| `createdBy`   | string | 创建邀请的 openid（应为户主或未来 delegate）           |
| `createdAt`   | Date   |                                          |


可选：`maxUses`、`usedCount` 若需限制多人扫同一码次数（默认 1 次最简）。

### 5.3 现有集合**不改**主键与归属

- `asset_accounts.ownerOpenid`、`asset_records.ownerOpenid`、`asset_snapshots` 等保持以**户主**为维度的现网设计。
- 所有权限在**读写的云函数**里通过 `openid` + `asset_share_members` 判断「是否代行户主」。

---

## 6. 云函数：访问判定（核心工具函数）

```text
// 伪代码
getAssetActingContext(callerOpenid, requestedOwnerOpenid?)
  - 若未传 requestedOwnerOpenid 或 等于 callerOpenid
      → 返回 { mode: "self", ownerOpenid: callerOpenid, role: "owner" }
  - 若传了 他人 ownerOpenid
      → 查 asset_share_members: ownerOpenid, memberOpenid: callerOpenid, status: active
      → 有则返回 { mode: "shared", ownerOpenid: requestedOwnerOpenid, role: viewer|manager }
      → 无则 拒绝

assertCanRead(owner)   // owner 或 viewer|manager
assertCanWrite(owner) // owner 或 manager（按 4. 节白名单）
assertOwnerOnly()      // 仅户主，用于成员管理、删户等
```

**所有**原先用 `if (doc.ownerOpenid !== openid)` 的地方，改为使用上述**目标户主**与**等效角色**判断。

---

## 7. API 设计（`ledgerFunctions` 的 `type`）

### 7.1 成员与邀请


| type                         | 作用      | 主要入参                   | 说明                                                |
| ---------------------------- | ------- | ---------------------- | ------------------------------------------------- |
| `createAssetShareInvite`     | 户主创建邀请  | `role`                 | 返回 `code`、过期时间                                    |
| `enterAssetShare`            | 受邀者接受   | `code`                 | 与 `enterLedger` 类似；写 `asset_share_members`        |
| `listAssetShareMembers`      | 户主列成员   | -                      | 仅 owner；返回 openid/昵称/角色/加入时间（昵称走 `user_profiles`） |
| `updateAssetShareMemberRole` | 户主改角色   | `memberOpenid`, `role` | `viewer` ↔ `manager`                              |
| `removeAssetShareMember`     | 户主移除    | `memberOpenid`         |                                                   |
| `exitAssetShare`             | 非户主主动退出 | `ownerOpenid`          |                                                   |
| `revokeAssetShareInvites`    | 撤销未使用邀请 | 可选 `code`              | 可选能力                                              |


### 7.2 现有资产类 type 的入参扩展

- 统一增加可选参数 `**asOwnerOpenid`**（或 `contextOwnerOpenid`）：
  - 缺省/等于本人：行为与现网一致（本人资产）。
  - 传**他人**时：仅当 `caller` 对该 `asOwnerOpenid` 有 `viewer` 或 `manager` 关系，否则 `PERMISSION_DENIED`。
- **只读** `type`（如 `listAssetAccounts`, `getAssetDashboard`, `listAssetRecords`, `getAssetAccount`, `getAssetRecord`, `listNetWorthTrend`）：`viewer` / `manager` 均可，内部把查询条件中 `ownerOpenid` 从 `caller` 换为 `asOwnerOpenid`。
- **写** `type`：仅 `owner` 或 `manager`；`manager` 再按 §4 白名单细拆。

> 若担心老客户端传参不全：缺省 `asOwnerOpenid` 时永远视为**本人**，兼容线上。

### 7.3 与账本流水联动（必须单列）

- `addTransaction` / `updateTransaction` 及定时执行路径里，凡涉及 `assetAccountId`：
  - 解析账户得 `ownerOpenid`（账户文档）；
  - 若 `callerOpenid === ownerOpenid` → 现网通过；
  - 若不等 → 需 `getAssetActingContext(caller, ownerOpenid).role === manager` 且**不允许 viewer 关链**（关链应视为写资产）。

---

## 8. 小程序交互要点

### 8.1 上下文切换

- 资产 Tab 增加「**当前数据归属**」切换：**我的** / **来自：XXX（只读/可管理）**。
- 将选中的 `asOwnerOpenid` 存入**页面级 state** 与**本地短缓存**（如 `lastAssetContextOpenid`），进入子页时携带。
- 所有 `callFunction` 在访问共享域时带 `asOwnerOpenid`；仅「我的」时不传或传自己。

### 8.2 只读态 UI

- 当 `role === viewer`：隐藏或禁用所有写入口：记变动、转账、编辑账户、归档、与流水关联时选此域账户等；若从账本记一笔点选资产，不展示只读户下的账户或置灰并提示。

### 8.3 可管理态 UI

- 与户主在**该上下文**下尽量一致，但**不提供**「共享管理」入口（仅户主在「我的」下可见新页面「资产共享管理」）。

### 8.4 新页面（建议路由）

- `pages/assets/asset-sharing` 或 放在「我的」下二级页：**生成邀请、成员列表、改角色、移除**（与 `pages/ledger-collaborators` 信息架构类似）。

### 8.5 分享卡片

- 可复用微信分享 `onShareAppMessage`：带 `code` 或 `scene`，落地页/入口调用 `enterAssetShare`；封面图可沿用项目固定图策略（与现网协作文案一致由产品定）。

---

## 9. 安全与合规模块

1. **最小权限**：默认受邀角色建议为 `viewer`；升级 `manager` 需户主显式操作或邀请时选高权。
2. **邀请码**：短有效期、可撤销；防止枚举暴力（限频、错误锁）。
3. **审计**（建议）：`asset_share_`* 操作写简要日志或依赖云开发日志 + 关键字段在 `user_profiles` 不存敏感仅展示昵称。
4. **越权双检**：任一带 `accountId` 的写，必须校验账户 `ownerOpenid` 与本次 `asOwnerOpenid` 一致且角色允许。

---

## 10. 迁移与兼容

- 现网数据无 `asset_share_`* 表亦可正常运行；**新表懒创建**（沿用 `ensureCollections` 思路）。
- 老版本小程序不传 `asOwnerOpenid` → 只访问本人，行为不变。

---

## 11. 测试要点（提测清单摘要）

- 户主 / viewer / manager 对每一类 `type` 的允许与拒绝表。
- 记一笔、定时、编辑流水、撤销商链时，在共享上下文下的资产联动。
- 退出共享后，立即失去访问；缓存 `asOwnerOpenid` 被清除或回退到「我的」。
- 多成员同时可管理时序（乐观锁不强制，资产侧现有并发策略为准）。

---

## 12. 后续可扩展

- **Per-account 共享**：在 `asset_share_members` 增加 `accountIds[]` 或子集合 `asset_share_scopes`。
- **转交户主**：危险操作，需多步确认与现网 `delete` / 合规模型。
- **只共享「总览+趋势」、不可看账户明细**：需单独 `role` 或权限位图。

---

## 13. 实现阶段建议


| 阶段  | 内容                                                                               |
| --- | -------------------------------------------------------------------------------- |
| P0  | 表结构 + 邀请/入列/退出的 `type` + `getAssetActingContext` + 只读 `type` 全打通 `asOwnerOpenid` |
| P1  | `manager` 写白名单 + 记一笔/定时/编辑流水 资产关链 + 资产 Tab 切换与 UI 禁用                             |
| P2  | 管理页、分享落地、限频、审计与运营工具                                                              |


---

## 14. 与项目文档的同步要求（定稿时）

本功能一旦落地，需按仓库规则同步 `README.md`（`type` 清单、页面索引）与 `AGENTS.md`（资产域能力与约定），与账本协作章并列说明**资产共享与账本无自动联动**。

---

## 15. 待产品拍板

1. `manager` 是否允许**删除**无任何 `asset_records` 的空账户。
2. 邀请**默认角色**是 `viewer` 还是可配置仅 `viewer` 可分享（禁止直接发 `manager` 邀请）。
3. 一个户主**共享人数上限**（如 20）。
4. 被共享方是否占用「我的资产 Tab」的显著位置（仅一个共享源 vs 多家庭列表）。

---

*文档版本：1.0 · 与当前 `cloudfunctions/ledgerFunctions/index.js` 行为对齐描述；实现时以代码与 PR 为准。*