# 协同记账（微信小程序 + 云开发）

微信原生小程序项目，核心能力包括：多账本、成员协作（邀请码/加入申请/审批）、流水与分类管理、统计分析（AntV F2）和定时记账（云函数定时触发）。

## 给新同学/AI 的速读入口（30 秒）

1. 看 `cloudfunctions/ledgerFunctions/index.js` 顶部注释和 `switch(type)`：业务口径、权限规则、接口能力都在这里。
2. 看 `miniprogram/app.json`：页面路由、Tab 配置（`custom: true`）与小程序启动页。
3. 看 `miniprogram/pages/ledgers/ledgers.js` + `miniprogram/custom-tab-bar/index.js`：账本页入口与 Tab 同步逻辑。

## 协作约定（AI/人工统一）

- 任何功能改动（新增/修改/删除行为）都必须**同步更新文档**，与代码同一轮提交完成。
- 至少更新：`README.md` 与 `AGENTS.md`。
- 如果改了云函数 `type`、页面调用关系或统计/权限口径，必须同步更新：
  - 「接口清单（`type` -> 页面调用方）」
  - 「页面索引（页面 -> `type`）」
  - 相关关键约定与自检清单
- 默认把“文档更新”视为功能交付的一部分，而不是可选项。

## 项目结构

- `miniprogram/`：前端小程序代码（WXML/WXSS/JS）
- `cloudfunctions/ledgerFunctions/`：主业务云函数（`index.js`、`scheduleLib.js`、`config.json`）
- `design-exports/`、`design-exports-v2/`：设计导出资源（不参与打包）
- `design-exports-v2/jizhang.pen`：设计工程文件（用于设计工具还原/对照）
- `AGENTS.md`：给 Cursor/协作者的项目规则与改动指引

## 运行与配置

- 在微信开发者工具打开工程（`project.config.json` 指定了 `miniprogramRoot` 与 `cloudfunctionRoot`）。
- 在 `miniprogram/app.js` 配置 `globalData.env` 为你的云环境 ID。
- `miniprogram/app.json` 已启用分包：主包仅保留 3 个 Tab 页；其余业务页按目录拆到多个 `subPackages.root`（如 `pages/ledger-detail`、`pages/ledger-manage`、`pages/ledger-collaborators` 等），用于控制主包大小不超过 2MB。
- `miniprogram/app.json` 已配置 `preloadRule`：进入任一 Tab 页后，在 `all` 网络下预下载上述业务分包，进一步降低首次进入业务页的等待时间。
- `project.config.json` 的 `packOptions.ignore` 已忽略 `node_modules` 与未使用的大图素材（路径以 `miniprogramRoot` 为根），避免上传时把本地依赖和演示资源打进代码包。
- 前端调用统一走：
  - `wx.cloud.callFunction({ name: "ledgerFunctions", data: { type: "..." } })`

## 开发前检查（建议）

- 确认 `miniprogram/app.js` 的 `globalData.env` 指向当前开发环境。
- 确认云函数已在微信开发者工具上传最新版 `ledgerFunctions`。
- 如果改统计图依赖，先执行 `cd miniprogram && npm install`，必要时执行 `npm run vendor:f2` 同步运行时。
- 如果改了接口入参，先对照 `cloudfunctions/ledgerFunctions/index.js` 的 `switch(type)` 与页面调用处。
- 统计页账本选择会记录到本地缓存（`lastAnalyzeLedgerId`），下次进入优先恢复；若该账本已删除/无权限会自动回退到可用账本。
- 账本页（`pages/ledgers/ledgers`）的多账本介绍 banner 在**非加载态始终展示**，不再按账本数量决定显隐。
- 我的页资料采用手动设置：点击圆头像触发 `chooseAvatar` 后会先上传云存储并调用 `updateMyProfile` 持久化（可只更新头像），点击昵称触发输入弹窗并保存；不依赖 `getUserProfile` 返回真实微信昵称。
- 我的页的「分类管理」「定时记账」入口点击后直接跳转，不在 `pages/mine` 预加载；目标页内自行展示 loading/加载态。
- 自定义 TabBar 的立体感仅通过 `box-shadow` 增强：不新增额外覆盖层，避免影响点击区域；样式集中在 `miniprogram/custom-tab-bar/index.wxss` 的 `tabbar-pill` 和 `tab-item-active`。选中态采用“双保险”：三个 Tab 页在 `onShow` 固定写入各自 `selected`，组件内保留“点击即时更新 + 路由同步兜底（`pageLifetimes.show`）”和切换中防重入；`switchTab.complete` 不做 route 回写，避免旧路由时序导致 active 慢一拍。

## 云函数与定时任务

- 云函数入口：`cloudfunctions/ledgerFunctions/index.js`
- 定时触发器：`cloudfunctions/ledgerFunctions/config.json`
  - 当前 Cron：`0 0 3 * * * *`（每天北京时间约 3:00）
- 定时规则计算：`cloudfunctions/ledgerFunctions/scheduleLib.js`

## 接口清单（`type` -> 页面调用方）

> 前端统一通过 `wx.cloud.callFunction({ name: "ledgerFunctions", data: { type, ... } })` 调用。  
> 以下仅列业务主线，`pages/index`、`pages/example` 里的 quickstart 示例不计入主流程。

- **账本**
  - `listLedgers` -> `pages/ledgers`、`pages/ledger-analytics`、`pages/ledger-schedule-edit`、`pages/ledger-categories`、`pages/mine`
  - `createLedger` -> `pages/ledgers`、`pages/mine`
  - `getLedger` -> `pages/ledger-manage`、`pages/ledger-collaborators`、`components/ledger-detail-view`
  - `updateLedgerName` -> `components/ledger-detail-view`、`pages/ledgers`（多账本列表底部抽屉）
  - `updateLedgerMonthlyBudget` -> `pages/ledger-budget`
  - `deleteLedger` -> `pages/ledger-manage`、`pages/ledgers`（多账本列表底部抽屉）、`components/ledger-detail-view`（详情标题「⋯」抽屉）
- **协作**
  - `enterLedger` -> `components/ledger-detail-view`
  - `createLedgerInvite` -> `pages/ledger-collaborators`、`components/ledger-detail-view`
  - `listLedgerCollaborators` -> `pages/ledger-collaborators`、`components/ledger-detail-view`
  - `reviewJoinRequest` -> `pages/ledger-pending`
  - `removeCollaborator` -> `pages/ledger-collaborators`
- **分类与流水**
  - `listCategories` -> `pages/ledger-tx`、`pages/ledger-categories`、`pages/ledger-schedule-edit`
  - `addLedgerCategory` / `removeLedgerCategory` -> `pages/ledger-categories`、`components/ledger-tx-form`
  - `listTransactions` -> `components/ledger-detail-view`
  - `getTransaction` -> `pages/ledger-tx`
  - `addTransaction` / `updateTransaction` / `deleteTransaction` -> `components/ledger-tx-form`
- **统计**
  - `analyzeLedger` -> `pages/ledger-analytics`
  - `listGroupTransactions` -> `pages/ledger-analytics-drill`
- **定时**
  - `listMySchedules` -> `pages/ledger-schedules`
  - `getSchedule` / `createSchedule` / `updateSchedule` / `deleteSchedule` -> `pages/ledger-schedule-edit`（部分状态切换也在 `pages/ledger-schedules`）
- **用户资料**
  - `getMyProfile` / `updateMyProfile` -> `pages/mine`

## 页面索引（页面 -> `type`）

- `pages/ledgers/ledgers`
  - `listLedgers`、`createLedger`、`updateLedgerName`、`deleteLedger`（非加载态始终展示多账本介绍 banner）
  - `listLedgers` 每条账本含：`monthIncomeCents` / `monthExpenseCents`（当前北京时间自然月，流水时间 `bookedAt ?? createdAt`）、`monthSummaryLabel`（如 `2026年4月`）、`monthlyBudgetCents`（可选）；单账本流水超过 1000 条时与 `analyzeLedger` 一样仅以前 1000 条参与汇总。
  - 多账本列表：卡片展示当月收入/支出；右侧「⋯」打开底部抽屉（预算设置 → `ledger-budget`、改名、协作者、删除）；非创建者点预算/改名/删除会提示无权限。抽屉打开时自定义 TabBar `hidden: true`；点「删除账本」后的确认弹窗期间同样隐藏，弹窗 `complete` 后恢复。
  - 本地快照：`wx.setStorageSync('ledgers_list_snap_v1', { list })` 缓存上次 `listLedgers` 结果；`refresh` 时若无缓存则全屏加载，有缓存则先渲染列表再等云函数返回更新（不提前消费 `showBillLedgerListOnce`）。
- `pages/ledger-manage/ledger-manage`
  - `getLedger`、`deleteLedger`
  - 用于账本管理入口与删除账本；协作者相关功能已拆分到独立页面。
  - 账本管理页不再提供“修改账本名称”入口；改名在账本详情标题「⋯」抽屉或「账本」Tab 多账本列表的「⋯」抽屉中操作。
  - 删除账本成功后统一 `switchTab` 回 `pages/ledgers/ledgers`，并清空 `showBillLedgerListOnce`；若仅剩一个账本将自动进入内嵌详情，多个账本则展示列表。
- `pages/ledger-collaborators/ledger-collaborators`
  - `getLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`removeCollaborator`
  - 提供微信分享邀请和协作者列表管理，待审批入口跳转到 `pages/ledger-pending`。
- `components/ledger-detail-view`
  - `enterLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`getLedger`、`updateLedgerName`、`deleteLedger`、`listTransactions`
  - 标题栏账本名称右侧「⋯」打开底部抽屉：预算设置、修改名称、协作者管理、删除账本（预算/改名/删除仅创建者，否则 Toast；协作者页对非创建者能力受限）；删除成功会 `triggerEvent('deleted')`。
  - 嵌入 `pages/ledgers`（`record-inline`）时抽屉打开/关闭及删账本确认弹窗通过 `bind:hosttabbar` 同步自定义 TabBar 显隐。
  - 本地快照：`wx.setStorageSync('ledger_detail_snap:${ledgerId}', …)` 写入 `listTransactions` 的原始流水数组及账本元信息；下次进入同一账本先展示缓存，接口返回后再刷新。首屏 `enterLedger` 完成至流水返回前展示 `miniprogram/images/ledger-detail-loading.png` 加载插图（源稿：`design-exports-v2/jizhang.pen` 画板「插画-加载中-账本」），避免误显示「暂无记录」空态插画。
- `pages/ledger-tx/ledger-tx` / `components/ledger-tx-form`
  - `listCategories`、`getTransaction`、`addTransaction`、`updateTransaction`、`deleteTransaction`、`addLedgerCategory`
- `pages/ledger-categories/ledger-categories`
  - `listLedgers`（无 `id` 入参直达时先解析可用账本）、`listCategories`、`addLedgerCategory`、`removeLedgerCategory`
- `pages/ledger-analytics/ledger-analytics`
  - `listLedgers`、`analyzeLedger`
- `pages/ledger-analytics-drill/ledger-analytics-drill`
  - `listGroupTransactions`
- `pages/ledger-schedules/ledger-schedules`
  - `listMySchedules`、`updateSchedule`（启停）
- `pages/ledger-schedule-edit/ledger-schedule-edit`
  - `listLedgers`、`getSchedule`、`listCategories`、`createSchedule`、`updateSchedule`、`deleteSchedule`
- `pages/mine/mine`
  - `listLedgers`、`getMyProfile`、`updateMyProfile`、`createLedger`

## 前端依赖（统计图表）

- `miniprogram/package.json` 使用 `@antv/f2-canvas`
- 仓库已提交 `miniprogram/miniprogram_npm/@antv/`，避免强依赖“构建 npm”
- 升级后可执行：
  - `cd miniprogram && npm install && npm run vendor:f2`

## 常见改动落点

- 改业务接口/权限：`cloudfunctions/ledgerFunctions/index.js`
- 改统计口径与展示：先改云函数，再改 `pages/ledger-analytics/*`
- 改账本入口交互：`pages/ledgers/ledgers.js`、`components/ledger-detail-view/*`
- 改管理分类页视觉：`pages/ledger-categories/*`，与 `pages/ledger-budget` / `pages/ledger-pending` 保持同一套 Pencil 蓝白卡片与胶囊按钮风格
- 改空状态视觉：优先复用已有插画资源；`components/ledger-detail-view` 的“最近流水空状态”与 `pages/ledger-schedules` 共用 `miniprogram/images/LmtpX.png`；`components/ledger-detail-view` 与 `pages/ledger-categories` 的加载态都用 `miniprogram/images/ledger-detail-loading.png`（勿与空态混淆）
- 改 Tab 行为：优先改 `miniprogram/custom-tab-bar/*`（包含选中态同步与显隐）；业务页仅在需要临时遮挡时调用 `getTabBar().setData({ hidden })`

## 提测前自检清单

- 账本主链路：创建账本 -> 进入账本 -> 新增流水 -> 编辑/删除流水。
- 协作链路：邀请码加入/申请审批/移除成员（至少验证一条）。
- 统计链路：月/年切换、分类与成员排行、明细下钻是否与流水一致。
- 定时链路：创建规则、启停规则、编辑规则后 `nextRunAt` 行为是否符合预期。
- 我的页面：资料更新与账本概览（已加入数量/空态新建）是否生效。
- 我的页面资料：仅选择头像后再次进入仍能回显；输入昵称后 `getMyProfile` 回显应与 `updateMyProfile` 保存值一致。
- 若改了路由或 Tab：验证三个 Tab 选中态与返回逻辑（含 `showBillLedgerListOnce` 场景）。

## 故障排查入口

- 云函数报错或权限异常：先看 `cloudfunctions/ledgerFunctions/index.js` 顶部注释和对应 `type` 分支。
- 账本列表与详情切换异常：看 `pages/ledgers/ledgers.js` 与 `globalData.showBillLedgerListOnce`。
- 统计口径不一致：先核对 `analyzeLedger` 返回，再看 `pages/ledger-analytics/*` 的渲染逻辑。
- 定时记账不触发：看 `cloudfunctions/ledgerFunctions/config.json` 的 Cron 与 `scheduleLib.js` 的时间计算。

## 部署说明

- 云函数建议通过微信开发者工具上传 `ledgerFunctions`
- 根目录 `uploadCloudFunction.sh` 目前是占位模板（函数名仍是 `quickstartFunctions`），使用前请先按本项目改名与参数

## 参考文档

- [微信小程序云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)

