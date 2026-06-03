# 资产共享功能 — 详细设计

> 状态：**设计稿**（尚未在代码中实现）  
> 基线：当前资产域按 `ownerOpenid` 与调用者 `openid` 一一对应，**无**多用户协作。  
> 目标：资产分为 **个人资产** 与 **共享资产** 两类视图；个人名下的账户可**按单个资产账户**共享给他人，被共享方分 **只读（viewer）** 与 **可编辑（editor）**；**不支持**「一次共享某用户名下全部账户」的全量共享。可编辑者**不可再共享**、**不可删除账户**。

---

## 1. 背景与目标

### 1.1 产品划分：个人资产 vs 共享资产


| 概念       | 含义                                                                                |
| -------- | --------------------------------------------------------------------------------- |
| **个人资产** | 当前用户作为 **户主（owner）** 名下的全部 `asset_accounts`（与现网一致：`ownerOpenid === 本人 openid`）。   |
| **共享资产** | 他人作为户主、且通过共享关系明确授权给你访问的 **单个或多个资产账户** 在你侧的统一呈现（仅包含被分享的 `accountId`，**不是**对方名下全量）；**列表按户主分组**展示。 |


**关系**：个人资产中的某一账户，经户主发起共享并被对方接受后，对该被共享方而言，该账户归入其 **共享资产** 列表（按账户粒度出现）；户主侧该账户仍在 **个人资产** 中，仅增加「已共享 / 共享管理」等标识与入口。**未**发起共享的账户不会出现在他人的共享资产里。

### 1.2 问题

- 家庭/小团队需要共同查看或维护部分资产账户，但当前数据只能归属单一 `openid`。
- 账本侧已有 `ledger_members`、邀请与角色经验，**资产域未复用**该模型。

### 1.3 设计目标

1. **显式、按账户共享**：仅针对**单个** `asset_account` 建立共享关系；不自动因账本成员而开通，也**不提供**「按户主一次性共享全部资产」能力。
2. **两档被共享方权限**：只读；可编辑（见 §4）。可编辑者**不可**再共享、**不可**删除账户。
3. **户主唯一**：`asset_accounts` / `asset_records` 仍归属户主 `ownerOpenid`；共享只增加**按账户**的访问控制。
4. **可运营、可撤**：支持按账户撤销共享、被共享方主动退出该账户、邀请过期。

### 1.4 非目标（本期不承诺）

- **全量共享**：不按 `ownerOpenid` 批量授权名下所有账户（若未来需要需另案设计）。
- 多「资产空间」/portfolio 产品线（可预留扩展，见 §12）。
- 与账本权限自动同步（不进账本即自动共享资产）。
- 被共享方把同一账户再「二次共享」给第三人。
- 行级脱敏（同一账户内部分记录隐藏）；本期按账户维度授权。

---

## 2. 范围定义：共享粒度（硬性）

**本期仅支持：按单个资产账户 `accountId` 共享。**

- 每一条共享关系绑定 **一个** `accountId` + **一个**被共享用户 `memberOpenid` + **角色** `viewer`|`editor`。
- 被共享方仅能访问该账户及其关联数据（该户下的 `asset_records`、参与总览/趋势时在业务上仅聚合**已被共享给你的账户**，见 §7、§8）。
- 同一账户可共享给多人；同一用户对不同账户可有不同角色。

---

## 3. 角色定义

角色均相对于**某一个已共享的 `accountId`** 界定（户主对自身名下账户不适用 viewer/editor，其为 `owner`）。


| 角色  | 英文建议     | 说明                                                            |
| --- | -------- | ------------------------------------------------------------- |
| 户主  | `owner`  | 账户 `ownerOpenid === 本人 openid`；对该账户可删除、可发起/撤销共享、可管理该账户的被共享列表。 |
| 只读  | `viewer` | 对该 `accountId` 仅查询；无写库。                                       |
| 可编辑 | `editor` | 对该 `accountId` 可执行允许的变动类写入（见 §4）；**不得**共享、**不得**删户。           |


「可编辑」**不是**共有人：数据归属仍为户主；若需审计可后续增加操作人字段。

---

## 4. 权限矩阵（建议）

**约定**：下列针对**某一 `accountId`**。`owner` 表示调用者即该账户户主；`editor`/`viewer` 表示调用者对该账户存在对应共享关系。


| 能力                             | owner      | editor       | viewer |
| ------------------------------ | ---------- | ------------ | ------ |
| 该账户及账户下记录/参与趋势的只读能力            | ✓          | ✓            | ✓      |
| 新建其它个人资产账户（全局）                 | ✓          | -            | -      |
| 对该共享账户：编辑信息、归档/恢复、期初/变动/转账等写操作 | ✓          | ✓（见注 1）      | ✗      |
| 删除该账户                          | ✓（受现网规则约束） | ✗ **固定**     | ✗      |
| 全量重算/快照类（若涉及「仅本人全部账户」）         | ✓          | 按 §7 缩小范围或禁止 | ✗      |
| 针对该账户：邀请、邀请码、改角色、移除被共享方        | ✓          | ✗ **固定**     | ✗      |
| 主动退出「他人共享给自己的该账户」              | -          | ✓            | ✓      |


**注 1（editor 写能力边界）**：以 `assertAccountAccess(openid, accountId)` 解析角色后：

- `viewer` → 仅只读；
- `editor` → 白名单内的账户级写 `type`，**排除** `deleteAssetAccount`、`createAssetAccount`（新建户属个人资产另议）、**排除**一切资产共享管理类接口（§7.1）；
- `owner` → 现网规则下的全部。

**注 2（记一笔/定时关联资产）**：仅当 `assetAccountId` 对应账户上，调用者为户主，或对该账户为 `editor`（viewer 不可关链）。校验路径：**账户 `_id` → `asset_account_shares`（按 accountId + memberOpenid）**。

---

## 5. 数据模型

### 5.1 集合 `asset_account_shares`（新，按账户粒度）

仅云函数读写；小程序不直连。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 建议 `memberOpenid_accountId` |
| `accountId` | string | `asset_accounts._id` |
| `ownerOpenid` | string | 冗余户主，便于校验与索引 |
| `memberOpenid` | string | 被共享方 |
| `role` | string | `viewer` \| `editor` |
| `status` | string | `active` \| `left` 等 |
| `joinedAt` | Date | 生效时间 |
| `invitedBy` | string | 邀请人 openid |
| `updatedAt` | Date | 可选 |

**索引建议**：`memberOpenid`+`status`（共享给我的账户）；`accountId`+`status`（某账户的成员列表）。

### 5.2 集合 `asset_account_share_invites`（新）

邀请**必须**绑定单一 `accountId`。

| 字段 | 说明 |
| --- | --- |
| `accountId`、`ownerOpenid`、`role`、`code`、`expiresAt`、`createdBy`、`createdAt` | 与账本邀请同类字段；`role` 为受邀者对该账户的角色 |

可选：`maxUses`、`usedCount`。

### 5.3 现有集合**不改**主键与归属

- `asset_accounts`、`asset_records`、`asset_snapshots` 仍以户主 `ownerOpenid` 为归属；**无**单独「共享资产」副本表。
- 权限：凡带 `accountId` 的路径调用 `getAccountAccess`（§6）。

---

## 6. 云函数：访问判定（核心工具函数）

以 **`accountId` 为锚**（列表/总览类见 §7 聚合规则）。

```text
getAccountAccess(callerOpenid, accountId)
  - 读 asset_accounts(accountId)，得 ownerOpenid
  - 若 callerOpenid === ownerOpenid → { role: "owner", ownerOpenid }
  - 否则查 asset_account_shares: accountId, memberOpenid: callerOpenid, status: active
      → 有则 { role: viewer|editor, ownerOpenid }
      → 无则 PERMISSION_DENIED

assertAccountRead(accountId)   // owner | viewer | editor
assertAccountWrite(accountId)  // owner | editor（白名单）
assertAccountOwner(accountId)  // 仅 owner：删户、共享管理
```

原先用 `doc.ownerOpenid !== openid` 一票否决的写法，改为：**先** `getAccountAccess`，再按角色放行。

---

## 7. API 设计（`ledgerFunctions` 的 `type`）

### 7.1 按账户的成员与邀请（均需 `accountId`）

| type | 作用 | 主要入参 | 说明 |
| --- | --- | --- | --- |
| `createAssetAccountShareInvite` | 户主就**某一账户**创建邀请 | `accountId`, `role` | 校验调用者为该账户 owner；写 `asset_account_share_invites` |
| `enterAssetAccountShare` | 受邀者接受 | `code` | 解析邀请得 `accountId`，写入 `asset_account_shares` |
| `listAssetAccountShareMembers` | 户主列该账户的被共享方 | `accountId` | 仅 owner |
| `updateAssetAccountShareMemberRole` | 户主改角色 | `accountId`, `memberOpenid`, `role` | |
| `removeAssetAccountShareMember` | 户主移除 | `accountId`, `memberOpenid` | |
| `exitAssetAccountShare` | 被共享方退出该账户 | `accountId` | |
| `revokeAssetAccountShareInvites` | 撤销未使用邀请 | `accountId`, 可选 `code` | |

命名可与实现时略缩，但语义须保持「**按账户**」。

### 7.2 列表与总览：个人资产 vs 共享资产

- **`listAssetAccounts`（扩展）**：建议增加 `scope`：`personal` \| `shared`（或等价枚举）。
  - `personal`：`ownerOpenid === caller`，与现网一致（个人资产）。
  - `shared`：`accountId ∈` 查询 `asset_account_shares` 中 `memberOpenid === caller` 且 `status` 有效；返回账户文档并附带 **`shareRole`**（viewer/editor）、**户主标识**（`ownerOpenid` + `user_profiles` 昵称/头像）。列表展示由前端**按户主分组**（见 §8.1）；接口可扁平返回，也可用可选参数 `groupBy=owner` 返回分组结构（实现二选一或与前端约定）。
- **`getAssetDashboard` / `listNetWorthTrend`**：
  - **个人资产**：仅聚合本人 `ownerOpenid` 下账户（现网）。
  - **共享资产**：仅聚合「共享给我的账户」集合内的账户；**不得**把户主名下未共享账户并入。
  - 若 Tab 需要在同一页切换「个人 / 共享」，由前端传 `scope` 或拆两次请求。
- **`listAssetRecords`**：`accountId` 必填或通过筛选传入时，`getAccountAccess` 必须通过方可列该户记录。
- **`getAssetAccount` / `getAssetRecord`**：凡涉及文档，按 `accountId` 做 `getAccountAccess`。

### 7.3 写操作与 `accountId`

- 所有写 `type` 在入参含 `accountId`（或可 derive）时：**户主**或对该账户的 **`editor`**（按白名单）；**viewer** 拒绝写。
- **`deleteAssetAccount`**：仅户主。
- **共享管理类 `type`**：仅对应账户户主。

> 老客户端不传 `scope` → 默认等同仅 **个人资产**，行为与线上一致。

### 7.4 与账本流水联动

- `assetAccountId` 指定后：`getAccountAccess(caller, accountId)`；户主或该账户 **`editor`** 允许关链；**viewer** 不允许。

---

## 8. 小程序交互要点

### 8.1 个人资产 / 共享资产切换

- 资产 Tab 主界面采用 **分段或子 Tab**：**个人资产** | **共享资产**。
- **个人资产**：即本人名下账户列表（`listAssetAccounts` + `scope=personal`）；账户详情内提供「共享给好友 / 管理已共享成员」（户主），分享的是**当前账户**而非全量。
- **共享资产**：仅展示他人共享给自己的账户（`scope=shared`）；**列表按户主分组**：每组顶部为户主（昵称/头像，来源 `ownerOpenid` + `user_profiles`），组内为该户主名下共享给自己的账户卡片；单行展示账户名及自己在该账户上的角色（只读/可编辑）。多户主时纵向多组排列，组内顺序可按余额或更新时间等产品规则定。
- 进入某一账户详情时，携带 `accountId`；所有请求由云函数按 §6 判定，**不再**使用「切换户主 openid」的全局上下文。

### 8.2 只读态 UI（viewer）

- 对该共享账户隐藏/禁用：记变动、转账、编辑账户、归档、记一笔/定时中关联该账户等。

### 8.3 可编辑态 UI（editor）

- 写入能力与 §4 一致；**不展示**该账户的「再共享 / 邀请 / 成员管理」；**不展示**删除账户。

### 8.4 户主侧（个人资产内）

- 账户详情或运营位：**按当前账户**生成邀请码、成员列表、改角色、移除；与账本协作者页类似，但粒度为 **单账户**。

### 8.5 分享卡片

- 分享参数需能还原 **`accountId` 或邀请 `code`**（邀请记录已含 `accountId`）；落地调用 `enterAssetAccountShare`。

---

## 9. 安全与合规模块

1. **最小权限**：默认受邀角色建议为 `viewer`；升级为 `editor` 须户主显式操作或邀请时指定（若产品允许邀请即带 `editor`）。
2. **邀请码**：短有效期、可撤销；防止枚举暴力（限频、错误锁）。
3. **审计**（建议）：`asset_account_share*` 相关操作写简要日志或依赖云开发日志；关键展示字段走 `user_profiles`，不存敏感。
4. **越权双检**：任一带 `accountId` 的访问，必须 `getAccountAccess`；禁止仅凭 `ownerOpenid` 匹配绕过。

---

## 10. 迁移与兼容

- 现网无 `asset_account_shares` 等表亦可正常运行；**新表懒创建**（沿用 `ensureCollections` 思路）。
- 老版本不传 `scope` → 默认仅 **个人资产**，与现网一致。

---

## 11. 测试要点（提测清单摘要）

- 户主 / viewer / editor 对每一类 `type` 的允许与拒绝表。
- 记一笔、定时、编辑流水、撤销商链时，对**已共享账户**的关链只放行户主/editor。
- 退出某一账户共享后，该账户从对应户主分组下消失；若该组已无账户可隐藏组头；详情页缓存 `accountId` 失效需回列表。
- 多成员同时为 `editor` 时的并发时序（乐观锁不强制，资产侧现有并发策略为准）。

---

## 12. 后续可扩展

- **全量按户主共享**（一次性共享某人名下全部账户）：本期明确不做；若未来需要需单独 PRD（与按账户模型并存或替代）。
- **转交户主**：危险操作，需多步确认。
- **更细粒度**：仅共享部分变动类型等（一般不优先）。

---

## 13. 实现阶段建议


| 阶段 | 内容 |
| --- | --- |
| P0 | `asset_account_shares` / invites + `getAccountAccess` + `listAssetAccounts(scope)` 个人/共享 + 只读 API 打通 |
| P1 | `editor` 写白名单 + 记一笔关链 + 净资产趋势按 scope 聚合 + Tab「个人/共享」 |
| P2 | 按账户邀请落地页、限频、审计 |


---

## 14. 与项目文档的同步要求（定稿时）

本功能一旦落地，需按仓库规则同步 `README.md`（`type` 清单、页面索引）与 `AGENTS.md`（资产域能力与约定），与账本协作章并列说明**资产共享与账本无自动联动**。

---

## 15. 待产品拍板

1. ~~共享粒度~~：**已定**——仅按账户；不做全量按户主共享。
2. ~~可编辑者删户 / 再共享~~：**已定**——否。
3. 邀请默认角色是否为 `viewer`；是否允许邀请时直接指定 `editor`。
4. **单账户**共享人数上限（如 20）。
5. ~~「共享资产」列表展示形态~~：**已定**——按户主分组（非平铺）。
6. `getAssetDashboard` / 趋势：个人与共享两套汇总是否在 UI 并排对比（产品可选）。

---

*文档版本：1.3 · 「共享资产」列表**按户主分组**展示；其余同 1.2。实现时以代码与 PR 为准。*