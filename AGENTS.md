# 项目说明（给 Cursor / 协作者）

## 是什么

微信**小程序** + **云开发**（云数据库 + 云函数），应用名「**协同记账**」。

当前能力覆盖：多账本、成员协作（邀请码 / 加入申请 / 审批）、流水、分类、统计（含 **AntV F2** 图表）、定时记账（云函数定时触发）。

## 给 Cursor 的速读入口（30 秒）

- 先看 `cloudfunctions/ledgerFunctions/index.js` 顶部注释 + `switch(type)`：这是业务口径、权限与接口能力的事实来源。
- 再看 `miniprogram/app.json`：确认页面路由、Tab 配置（`custom: true`）与冷启动首屏。
- 最后看 `miniprogram/pages/ledgers/ledgers.js` 与 `miniprogram/custom-tab-bar/index.js`：理解账本 Tab 入口、单账本内嵌详情、Tab 选中同步逻辑。

## 文档同步硬规则（必须执行）

- 只要 AI 改了功能（新增/修改/删除行为、接口、页面交互、统计口径、权限、定时逻辑），**必须在同一轮改动里同步更新文档**。
- 至少同步这两个文件：`README.md`（面向开发者）和 `AGENTS.md`（面向 Cursor/协作者）。
- 若改动涉及云函数 `type`，必须同时更新：
  - `README.md` 的「接口清单（type -> 页面调用方）」与「页面索引（页面 -> type）」
  - `AGENTS.md` 的能力说明/改动落点（必要时补充关键约定）
- 若本次功能改动未更新文档，视为任务未完成。

## 目录

| 路径 | 作用 |
|------|------|
| `miniprogram/` | 小程序前端：`app.js` / `app.json` / `pages/*` / `components/*` |
| `miniprogram/custom-tab-bar/` | **自定义 TabBar**（`app.json` 里 `tabBar.custom: true`）；选中态由各 Tab 页在 `onShow` 显式写入（`selected`/`hidden`），组件仅负责渲染，不再基于 route 自动同步 |
| `cloudfunctions/ledgerFunctions/` | 主业务云函数：`index.js`、`scheduleLib.js`、`config.json` |
| `design-exports/`、`design-exports-v2/` | 设计资源（**不参与小程序打包**）：PNG 截图 + `design-exports-v2/jizhang.pen`（Pencil 类工具的工程 JSON，内含 frame/画板，可与导出图对照） |
| `project.config.json` | 微信工程：`miniprogramRoot`、`cloudfunctionRoot`、编译选项 |
| `miniprogram/package.json` | 前端 npm 依赖（当前含 `@antv/f2-canvas`，供统计页图表） |
| `miniprogram/miniprogram_npm/@antv/` | 已随仓库提交的 F2 运行时（`f2-canvas` + `wx-f2` 1.x 的 `wx-f2.min.js`），避免依赖微信开发者工具「构建 npm」才能解析组件 |

## 技术栈与关键约定

- **原生**小程序（WXML / WXSS / JS），不是 Vue 工程。
- 工程配置里 `nodeModules: true`；统计页 F2 使用已提交的 `miniprogram/miniprogram_npm/`（无需微信开发者工具「构建 npm」）。升级 `@antv/f2-canvas` 并在 `miniprogram` 下执行 `npm install` 后，可运行 `npm run vendor:f2` 重新同步 `miniprogram_npm`。
- `miniprogram/app.json` 使用按目录分包：主包只放 3 个 Tab 页，其余业务页拆到多个 `subPackages.root`（避免将主包 Tab 页落入分包范围）。
- `miniprogram/app.json` 启用 `preloadRule`：进入任一 Tab 页后，在 `all` 网络预下载业务分包，优先保证后续页面打开速度。
- `project.config.json` 的 `packOptions.ignore` 以 `miniprogramRoot` 为根目录生效：必须忽略 `node_modules`，并按需忽略未使用的演示素材，避免主包/分包上传时触发 2MB 限制。
- 云环境 ID：`miniprogram/app.js` → `globalData.env`（示例值 `dev-4iov0`，上线请换成自己的环境）。
- 版本更新：`miniprogram/app.js` 在 `onLaunch` 自动注册 `wx.getUpdateManager()`；有新版本时弹窗确认后 `applyUpdate`，下载失败时 `toast` 提示。
- 小程序调云函数：`wx.cloud.callFunction({ name: "ledgerFunctions", data: { type: "...", ... } })`。
- 云函数首次运行会 `ensureCollections` 尝试创建集合（已存在则忽略错误）。
- **流水时间**：`transactions` 可有 `bookedAt`（用户选的记账日）；列表与统计按 `bookedAt ?? createdAt`（见 `ledgerFunctions/index.js` 顶部注释）。
- **默认分类**：新建账本默认注入 18 个高频分类（餐饮、早餐、午餐、晚餐、买菜、交通、住房、水电燃气、通讯网络、日用、服饰、购物、医疗、教育、人情、旅行、娱乐、其他）；若账本历史数据无分类，`listCategories` 迁移时也回填同一套默认值。
- **分类 icon 显示层**：分类名前 icon 统一由 `miniprogram/category-icons.js` 映射；新增分类可点选 icon 网格或输入自定义 emoji（emoji 优先），保存为“emoji + 分类名”文本，页面展示与云函数口径保持一致（记一笔、定时记账、分类管理）。
- **记一笔分类选择交互**：`components/ledger-tx-form` 不再使用系统 `picker`；主表单点击「分类」打开底部弹窗，弹窗内铺平双列可滚动网格点选，长分类名与 emoji 分类可完整阅读。
- **定时记账分类选择交互**：`pages/ledger-schedule-edit` 同为底部弹窗 + 铺平网格；`status=completed` 时不打开弹窗并保持整行禁用观感。
- **定时记账列表页新增入口**：`pages/ledger-schedules` 底部固定主按钮文案为「新家定时记账」，列表态与空态都可直接进入新建定时任务页。
- **月支出预算**：`ledgers.monthlyBudgetCents`（可选，分，自然月支出上限）；由创建者在 `pages/ledger-budget` 或 `components/ledger-detail-view` 标题「⋯」抽屉中维护，云函数 `updateLedgerMonthlyBudget`。
- **账本改名入口**：仅创建者可见 `components/ledger-detail-view` 标题栏账本名称右侧「⋯」底部抽屉中的「修改账本名称」；`pages/ledger-manage` 不提供改名入口。
- **多账本列表行**：`listLedgers` 返回每条 `monthIncomeCents` / `monthExpenseCents` / `monthSummaryLabel`（当月北京时间自然月，流水时间 `bookedAt ?? createdAt`；每账本最多 1000 条流水参与汇总，与 `analyzeLedger` 一致）；`design-exports-v2/jizhang.pen` 画板「01-账本列表」中卡片示意与列表布局对齐。列表卡片右侧仅保留「记一笔」按钮，并在右侧区域上下居中，不再展示「⋯」菜单。
- **账本列表 / 详情底部抽屉与 TabBar**：`pages/ledgers` 多账本列表不再展示「⋯」操作菜单；`ledger-detail-view` 标题「⋯」仅创建者可见。创建者在详情页打开操作抽屉期间隐藏自定义 TabBar（嵌入 Tab 时详情组件 `triggerEvent('hosttabbar')`，由 `pages/ledgers` 消费）；独立打开 `pages/ledger-detail` 时组件内直接 `getTabBar()`。关闭抽屉、`pageLifetimes.hide` 离页或改名/删账本确认弹窗 `complete` 时恢复；列表页 `onShow` 仍按页内 `sheetOpen` 同步 `hidden`。
- **详情页固定「记一笔」按钮**：`components/ledger-detail-view` 在非 `recordInline` 模式下使用底部 fixed 按钮，默认保持水平居中显示。
- **详情页最近流水分组**：`components/ledger-detail-view` 将 `listTransactions` 结果按记账日期分组展示（今天 / 昨天 / 具体日期 `YYYY-MM-DD`）；分组内单条流水不再展示日期，仅在有时分时显示 `HH:mm`。
- **协作者管理页拆分**：`pages/ledger-manage` 仅保留管理入口与删账本；微信邀请与协作者列表统一放在 `pages/ledger-collaborators`。
- **协作者邀请卡片样式**：`pages/ledger-collaborators` 的 `onShareAppMessage` 使用自定义标题（含账本名，超长自动截断）+ 固定封面图 `miniprogram/images/LmtpX.png`，分享出去的微信卡片视觉与文案保持稳定。
- **我的页分享入口**：`pages/mine` 新增「分享给朋友」卡片按钮（`open-type="share"`）；`onShareAppMessage` 标题优先带当前昵称，封面图固定 `miniprogram/images/LmtpX.png`。
- **页面分享权限口径**：全局页面默认隐藏微信分享菜单（`wx.hideShareMenu`）；仅 `pages/ledger-collaborators` 与 `pages/mine` 在页面生命周期内放开 `shareAppMessage`。
- **详情协作入口**：`components/ledger-detail-view` 标题「⋯」对账本成员可见；创建者菜单含预算/改名/协作者管理/删账本，非创建者菜单仅保留「退出账本」（云函数 `exitLedger`）。
- **流水改删权限**（云函数侧）：`getTransaction` / `updateTransaction` / `deleteTransaction` 仅允许**该条流水的记录人**；若历史数据无 `createdByOpenid`，仅**账本创建者**可改删（见 `index.js` 顶部注释）。
- **账本 Tab 列表优先**：`globalData.showBillLedgerListOnce` 为 `true` 时，下次 `pages/ledgers/ledgers` 的 `refresh` 会**强制展示账本列表**（即使只有一个账本也不进入内嵌详情）；标志在消费后清零。由 `ledger-detail`、`ledger-manage` 等在删账本等场景内置位。
- **删账本返回落点**：`pages/ledger-manage` 删除账本成功后统一 `switchTab` 到 `pages/ledgers/ledgers`，并清空 `showBillLedgerListOnce`；因此仅剩一个账本时会自动进入详情，多个账本时显示列表。
- **账本列表缓存**：`pages/ledgers/ledgers.js` 的 `refresh` 使用 `ledgers_list_snap_v1` 本地键先展示上一屏 `listLedgers` 数据，接口成功后再覆盖并写回缓存；应用缓存时**不**清零 `showBillLedgerListOnce`（与云函数返回后的消费逻辑一致）。
- **账本页多账本引导条**：`pages/ledgers/ledgers` 的“多账本，账目更清晰”banner 在**非加载态始终展示**（单账本内嵌详情 / 多账本列表 / 空账本均显示），点击统一走 `createLedger`。
- **统计账本记忆**：`pages/ledger-analytics` 通过本地缓存 `lastAnalyzeLedgerId` 记住用户上次选择的统计账本；若该账本已删除或无权限，会自动回退到当前可访问账本，避免报错。
- **用户资料设置口径**：`pages/mine` 不依赖 `getUserProfile` 直接同步真实微信资料；点击圆头像触发 `chooseAvatar` 后会先上传云存储并调用 `updateMyProfile` 持久化（头像可单独保存），点击昵称触发弹窗输入并调用 `updateMyProfile` 保存展示名；未设置昵称时，昵称展示与流水页一致，回退匿名 openid（`…` + 后 8 位）。
- **我的页跳转体验**：`pages/mine` 的「分类管理」「定时记账」点击后直接跳转目标页，不在我的页预加载；加载态由 `pages/ledger-categories`、`pages/ledger-schedules` 各自承担。
- **自定义 TabBar 视觉**：`miniprogram/custom-tab-bar` 的立体感优先用 `box-shadow`（`tabbar-pill`、`tab-item-active`）实现，不新增额外覆盖层，避免遮挡点击区域；改 Tab 视觉时优先在该目录调整，避免影响 Tab 选中同步逻辑。
- **Tab 选中态口径**：`selected` 由三个 Tab 页在 `onShow` 明确写入固定索引（账本=0、统计=1、我的=2）；`miniprogram/custom-tab-bar/index.js` 不再基于 `getCurrentPages()` 做 route 同步，避免切 Tab 过渡期读到旧路由导致“抖”。组件在点击 Tab 时会先即时 `setData({ selected })`，视觉更快，最终以页面 `onShow` 为准。

## 云函数与调度

- 入口：`cloudfunctions/ledgerFunctions/index.js` → `exports.main`。
- 定时触发：`cloudfunctions/ledgerFunctions/config.json` → `ledgerScheduleTimer`，Cron `0 0 3 * * * *`（每天北京时间约 3:00）；`nextRunAt` 按日历日（北京时间 0 点）在 `scheduleLib.js` 计算，保存后若已到期会在 `createSchedule`/`updateSchedule` 内立即尝试入账。

`type` 与实现分支对应（维护时请与 `switch (type)` 保持一致）：

- 账本：`createLedger`、`listLedgers`、`updateLedgerName`、`updateLedgerMonthlyBudget`、`getLedger`、`deleteLedger`
- 协作：`enterLedger`、`joinLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`reviewJoinRequest`、`removeCollaborator`、`exitLedger`
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

**其它业务页**（节选）：`ledger-detail`（单账本主页）、`ledger-manage`（账本管理入口与删账本）、`ledger-collaborators`（微信邀请与协作者列表）、`ledger-categories`、`ledger-tx`、`ledger-analytics-drill`、`ledger-schedules`、`ledger-schedule-edit`。

`app.json` 里 **`pages` 数组第一项**为小程序冷启动首屏（当前为 `ledgers`）；第二项为 `mine`（非首 Tab，仅路由顺序）。

**模板 / 示例**：`pages/index/index`、`pages/example/index`（按需保留或清理）。

常用组件：`ledger-detail-view`、`ledger-tx-form`、`cloudTipModal`。

## 修改代码时建议

- 权限、数据一致性、统计口径、新业务：`cloudfunctions/ledgerFunctions/index.js`（注释与 `switch(type)` 为权威说明）。
- 定时规则与时间边界：`scheduleLib.js`。
- Tab 样式与选中同步：优先改 `custom-tab-bar`（组件负责渲染与点击即时 setData）；各 Tab 页仅在临时隐藏 TabBar 时调用 `getTabBar().setData({ hidden })`。
- 路由与页面注册：`app.json`。
- 根目录 `uploadCloudFunction.sh` 目前是**占位模板**（函数名仍为 `quickstartFunctions`），部署 **`ledgerFunctions`** 请用微信开发者工具上传，或自行改写脚本中的函数名与环境参数。

## 常见改动落点

- 新增/修改业务接口：改 `ledgerFunctions/index.js` 对应 `case`，并同步前端 `wx.cloud.callFunction` 的 `type` 与入参。
- 调整统计展示或口径：先改云函数聚合返回，再改 `pages/ledger-analytics/*` 与 `pages/ledger-analytics-drill/*`。
- 调整账本页交互：优先看 `pages/ledgers/ledgers.js`、`components/ledger-detail-view/*`、`globalData.showBillLedgerListOnce`。
- 成员头像/昵称展示：`listLedgerCollaborators` 返回 `avatarUrl`；`listTransactions`/`listGroupTransactions` 返回 `payerAvatarUrl`；`analyzeLedger` 的 `groupsByPerson` 返回 `avatarUrl`（并在对应列表中以“头像+昵称”渲染）。
- 调整空状态插画：优先复用既有素材；`ledger-detail-view` 的“最近流水空状态”与 `pages/ledger-schedules` 统一使用 `miniprogram/images/LmtpX.png`，且两处空态插图都可点击直达新增页（详情空态进“记一笔”，定时空态进“新建定时任务”）；`ledger-detail-view`（含「加载中」「流水同步中」）与 `pages/ledger-categories` 的加载态统一使用 `miniprogram/images/ledger-detail-loading.png`（Pencil 稿：`design-exports-v2/jizhang.pen` /「插画-加载中-账本」），且详情组件对上一屏有 `wx.setStorage` 快照（键 `ledger_detail_snap:${ledgerId}`），再次进入先渲染缓存再等 `listTransactions`。
- 调整定时记账规则：改 `scheduleLib.js` + `config.json`（确认 Cron 与 nextRunAt 语义一致）。

## 改动自检清单（给 Cursor）

- 改了云函数 `type`：同步检查前端调用 `type`、入参名和返回字段消费点。
- 改了权限/口径：至少覆盖一条正向流程与一条边界流程（如无权限、空数据、历史数据）。
- 改了 Tab 或页面路由：验证 `custom-tab-bar` 选中态与 `app.json` 注册顺序是否匹配。
- 改了定时逻辑：同时校对 `config.json` Cron、`scheduleLib.js` 时间边界和保存后立即执行分支。
- 改了统计：核对 `analyzeLedger` 的汇总、排行、趋势是否与明细流水一致。

## 故障定位优先级

- 第一步：定位具体 `type`（页面调用 -> 云函数 `switch(type)` 分支）。
- 第二步：核对该分支的权限校验与关键字段（如 `ledgerId`、`txId`、`createdByOpenid`、`bookedAt`）。
- 第三步：回看页面消费逻辑（是否假设了不存在的字段或旧口径）。
