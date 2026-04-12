# 项目说明（给 Cursor / 协作者）

## 是什么

微信**小程序** + **云开发**（云数据库 + 云函数），应用名「**协同记账**」。

当前能力覆盖：多账本、成员协作（邀请码 / 加入申请 / 审批）、流水、分类、统计（含 **AntV F2** 图表）、定时记账（云函数定时触发）。

## 目录

| 路径 | 作用 |
|------|------|
| `miniprogram/` | 小程序前端：`app.js` / `app.json` / `pages/*` / `components/*` |
| `miniprogram/custom-tab-bar/` | **自定义 TabBar**（`app.json` 里 `tabBar.custom: true`）；三个 Tab 页在 `onShow` 等里通过 `getTabBar()` 同步选中态 |
| `cloudfunctions/ledgerFunctions/` | 主业务云函数：`index.js`、`scheduleLib.js`、`config.json` |
| `design-exports/`、`design-exports-v2/` | 设计资源（**不参与小程序打包**）：PNG 截图 + `design-exports-v2/jizhang.pen`（Pencil 类工具的工程 JSON，内含 frame/画板，可与导出图对照） |
| `project.config.json` | 微信工程：`miniprogramRoot`、`cloudfunctionRoot`、编译选项 |
| `miniprogram/package.json` | 前端 npm 依赖（当前含 `@antv/f2-canvas`，供统计页图表） |
| `miniprogram/miniprogram_npm/@antv/` | 已随仓库提交的 F2 运行时（`f2-canvas` + `wx-f2` 1.x 的 `wx-f2.min.js`），避免依赖微信开发者工具「构建 npm」才能解析组件 |

## 技术栈与关键约定

- **原生**小程序（WXML / WXSS / JS），不是 Vue 工程。
- 工程配置里 `nodeModules: true`；统计页 F2 使用已提交的 `miniprogram/miniprogram_npm/`（无需微信开发者工具「构建 npm」）。升级 `@antv/f2-canvas` 并在 `miniprogram` 下执行 `npm install` 后，可运行 `npm run vendor:f2` 重新同步 `miniprogram_npm`。
- 云环境 ID：`miniprogram/app.js` → `globalData.env`（示例值 `dev-4iov0`，上线请换成自己的环境）。
- 小程序调云函数：`wx.cloud.callFunction({ name: "ledgerFunctions", data: { type: "...", ... } })`。
- 云函数首次运行会 `ensureCollections` 尝试创建集合（已存在则忽略错误）。
- **流水时间**：`transactions` 可有 `bookedAt`（用户选的记账日）；列表与统计按 `bookedAt ?? createdAt`（见 `ledgerFunctions/index.js` 顶部注释）。
- **月支出预算**：`ledgers.monthlyBudgetCents`（可选，分，自然月支出上限）；由创建者在账本管理里维护，云函数 `updateLedgerMonthlyBudget`。
- **流水改删权限**（云函数侧）：`getTransaction` / `updateTransaction` / `deleteTransaction` 仅允许**该条流水的记录人**；若历史数据无 `createdByOpenid`，仅**账本创建者**可改删（见 `index.js` 顶部注释）。
- **账本 Tab 列表优先**：`globalData.showBillLedgerListOnce` 为 `true` 时，下次 `pages/ledgers/ledgers` 的 `refresh` 会**强制展示账本列表**（即使只有一个账本也不进入内嵌详情）；标志在消费后清零。由 `ledger-detail`、`ledger-manage` 等在删账本等场景内置位。

## 云函数与调度

- 入口：`cloudfunctions/ledgerFunctions/index.js` → `exports.main`。
- 定时触发：`cloudfunctions/ledgerFunctions/config.json` → `ledgerScheduleTimer`，Cron `0 0 3 * * * *`（每天北京时间约 3:00）；`nextRunAt` 按日历日（北京时间 0 点）在 `scheduleLib.js` 计算，保存后若已到期会在 `createSchedule`/`updateSchedule` 内立即尝试入账。

`type` 与实现分支对应（维护时请与 `switch (type)` 保持一致）：

- 账本：`createLedger`、`listLedgers`、`updateLedgerName`、`updateLedgerMonthlyBudget`、`getLedger`、`deleteLedger`、`setDefaultAnalyzeLedger`
- 协作：`enterLedger`、`joinLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`reviewJoinRequest`、`removeCollaborator`
- 分类与流水：`listCategories`、`addLedgerCategory`、`removeLedgerCategory`、`listTransactions`、`addTransaction`、`getTransaction`、`updateTransaction`、`deleteTransaction`
- 统计：`analyzeLedger`（`groups` / `groupsByPerson` 为**支出**维度的排行；汇总净额等仍含收支；另含 `trendPoints`、`pieGroups*` 等）、`listGroupTransactions`
- 定时：`listMySchedules`、`createSchedule`、`getSchedule`、`updateSchedule`、`deleteSchedule`
- 用户资料：`getMyProfile`、`updateMyProfile`

## 云数据库集合（概念）

与 `COLLECTION_NAMES` 一致（细节以 `index.js` 注释与代码为准）：

- `ledgers`、`ledger_members`、`ledger_join_requests`、`ledger_invites`
- `transactions`、`ledger_schedules`、`user_profiles`

## 页面（`miniprogram/app.json`）

**Tab 页**（与 `custom-tab-bar` 中 `pagePath` 一致）：

- `pages/ledgers/ledgers` — 账本（列表 / 入口；文案与 `app.json` tabBar、`custom-tab-bar` 一致）  
- `pages/ledger-analytics/ledger-analytics` — 统计  
- `pages/mine/mine` — 我的  

**其它业务页**（节选）：`ledger-detail`（单账本主页）、`ledger-manage`（协作与**月预算**等管理）、`ledger-categories`、`ledger-tx`、`ledger-analytics-drill`、`ledger-schedules`、`ledger-schedule-edit`。

`app.json` 里 **`pages` 数组第一项**为小程序冷启动首屏（当前为 `ledgers`）；第二项为 `mine`（非首 Tab，仅路由顺序）。

**模板 / 示例**：`pages/index/index`、`pages/example/index`（按需保留或清理）。

常用组件：`ledger-detail-view`、`ledger-tx-form`、`cloudTipModal`。

## 修改代码时建议

- 权限、数据一致性、统计口径、新业务：`cloudfunctions/ledgerFunctions/index.js`（注释与 `switch(type)` 为权威说明）。
- 定时规则与时间边界：`scheduleLib.js`。
- Tab 样式与选中同步：`custom-tab-bar` + 各 Tab 页的 `getTabBar()` 调用。
- 路由与页面注册：`app.json`。
- 根目录 `uploadCloudFunction.sh` 目前是**占位模板**（函数名仍为 `quickstartFunctions`），部署 **`ledgerFunctions`** 请用微信开发者工具上传，或自行改写脚本中的函数名与环境参数。
