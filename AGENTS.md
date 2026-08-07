# 项目说明（给 Cursor / 协作者）

## 是什么

微信**小程序** + **云开发**（云数据库 + 云函数），应用名「**协同记账**」。

当前能力覆盖：多账本、成员协作（邀请码 / 加入申请 / 审批）、流水、分类、全局资产管理、统计（含 **AntV F2** 图表）、定时记账（云函数定时触发）。

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
| `design-exports/`、`design-exports-v2/` | 设计资源（**不参与小程序打包**）：PNG 截图 + `design-exports-v2/jizhang.pen`（Pencil 类工具的工程 JSON，内含 frame/画板，可与导出图对照）；单账户管理页画板名为 **`11-单账户管理-V4`**（资产 Tab → 账户详情）。 |
| `project.config.json` | 微信工程：`miniprogramRoot`、`cloudfunctionRoot`、编译选项 |
| `miniprogram/package.json` | 前端 npm 依赖（当前含 `@antv/f2-canvas`，供统计页图表） |
| `miniprogram/miniprogram_npm/@antv/` | 已随仓库提交的 F2 运行时（`f2-canvas` + `wx-f2` 1.x 的 `wx-f2.min.js`），避免依赖微信开发者工具「构建 npm」才能解析组件 |

## 技术栈与关键约定

- **原生**小程序（WXML / WXSS / JS），不是 Vue 工程。
- 工程配置里 `nodeModules: true`；统计页 F2 使用已提交的 `miniprogram/miniprogram_npm/`（无需微信开发者工具「构建 npm」）。升级 `@antv/f2-canvas` 并在 `miniprogram` 下执行 `npm install` 后，可运行 `npm run vendor:f2` 重新同步 `miniprogram_npm`。
- `miniprogram/app.json` 使用按目录分包：主包只放 4 个 Tab 页（账本/统计/资产/我的），其余业务页拆到多个 `subPackages.root`（避免将主包 Tab 页落入分包范围）。
- `miniprogram/app.json` 启用 `preloadRule`：进入任一 Tab 页后，在 `all` 网络预下载业务分包，优先保证后续页面打开速度。
- `project.config.json` 的 `packOptions.ignore` 以 `miniprogramRoot` 为根目录生效：必须忽略 `node_modules`，并按需忽略未使用的演示素材，避免主包/分包上传时触发 2MB 限制。
- 云环境 ID：`miniprogram/app.js` → `globalData.env`（示例值 `dev-4iov0`，上线请换成自己的环境）。
- 版本更新：`miniprogram/app.js` 在 `onLaunch` 自动注册 `wx.getUpdateManager()`；有新版本时弹窗确认后 `applyUpdate`，下载失败时 `toast` 提示。
- 小程序调云函数：`wx.cloud.callFunction({ name: "ledgerFunctions", data: { type: "...", ... } })`。
- 云函数首次运行会 `ensureCollections` 尝试创建集合（已存在则忽略错误）。
- **流水时间**：`transactions` 可有 `bookedAt`（记一笔中用户选的日期+时刻，落库为毫秒；列表按该时间倒序。新建时“秒/毫秒”在确认瞬间取自当前时间以区分同分钟内连续记账；UI 上详情列表仍可按日分组，仅必要时分、不展示秒）。列表与统计按 `bookedAt ?? createdAt`（见 `ledgerFunctions/index.js` 顶部注释）。
- **默认分类**：新建/空账本默认注入 **18 个支出** + **6 个收入**（支出为餐饮、早/午/晚餐、买菜、交通、住房、水电燃气、通讯网络、日用、服饰、购物、医疗、教育、人情、旅行、娱乐、其他；收入为工资、奖金、理财、收租、红包、其他收入），预置 24 类，单账本分类总数上限制为 **48**；无分类的旧账本在迁移/拉取时也会补全预置**收入**类。云函数在 `ledgers` 上可选 `categoryByFlow: { 分类名: "income"|"expense" }`，用于**非预置**自定义名的收支归属；未标记的历史自定义名在记一笔中收支两侧均可选（`both`）。`listCategories` / `getTransaction` / `getLedger` / `enterLedger` 除 `list` / `categories` 外带 `expenseList`、`incomeList`。
- **分类 icon 显示层**：分类名前 icon 统一由 `miniprogram/category-icons.js` 映射；预置支出/预置收入类名（如餐饮、工资、收租等）有固定 emoji，新增分类可点选 icon 网格或输入自定义 emoji（emoji 优先），保存为“emoji + 分类名”文本，页面展示与云函数口径保持一致（记一笔、定时记账、分类管理）。
- **记一笔分类选择交互**：`components/ledger-tx-form` 不再使用系统 `picker`；主表单点击「分类」打开底部弹窗，弹窗内铺平双列可滚动网格点选，长分类名与 emoji 分类可完整阅读。顶部「支出 / 收入」为分段点选，直接切换、不弹系统选单；**弹窗与当前选中的收入/支出一致，只展示 `expenseList` 或 `incomeList`**，与流水 `flow` 提交前在云函数侧一致校验。内联「新增分类」会随当前收支柱调用 `addLedgerCategory` 并传 `forFlow`。
- **记一笔提交防重复**：`components/ledger-tx-form` 的「确认记账」/「保存修改」在 `onSubmit` 中用实例级 `_submitting` 同步锁配合 `saving` 状态禁用主按钮，避免快速连点重复调用 `addTransaction` / `updateTransaction`。
- **记一笔图片附件**：`components/ledger-tx-form` 备注下方可选上传图片（仅图，最多 **9** 张）：`wx.chooseMedia` → `wx.cloud.uploadFile`（路径 `tx-attachments/…`）→ 提交 `attachments: [{ fileID, name?, size?, contentType? }]`；云函数校验 `cloud://` 与上限；`getTransaction` / `listTransactions` / `listGroupTransactions` 回传；编辑可增删；从未保存即移除的新上传会在客户端 `deleteFile`，保存后移出或删整条流水由云函数尽力删云文件。详情 `ledger-detail-view` 与统计下钻展示缩略图，点击 `previewImage`（`catchtap` 不进编辑）。
- **记一笔关联资产（可选）**：`pages/ledger-tx/ledger-tx` 加载 `listAssetAccounts`（非归档）并传入 `ledger-tx-form`；表单项「资产账户」默认「不关联」，**若账本已设置 `defaultAssetAccountId`**（创建者在 `pages/ledger-default-account` 或详情「⋯」抽屉维护，云函数 `updateLedgerDefaultAssetAccount`）则记一笔**新增**时支出与收入均默认选中该账户（切换账本同步切换；用户仍可改为不关联或其它账户）。**若当前无任何非归档资产账户则不展示该行**（编辑流水若仍关联已删除账户时仍会展示，便于改为不关联）。若选择则 `addTransaction` 成功后再写 `asset_records`（增/减随收支）、更新该账户余额，并在 `transactions` 写入 `assetAccountId`/`assetAccountName`、`sourceAssetEffectCents`（有符号分）、`primaryAssetRecordId`；**编辑/删除**该流水时资产侧**再追加**一条 `asset_records`（不删改历史行），并带 `sourceLedgerId`/`sourceLedgerName`/`sourceLedgerTxId`/`sourceOperation`（`ledger_create`/`ledger_update`/`ledger_delete`）等字段；删除流水时按 `sourceAssetEffectCents` 冲销。仅展示标签、从未成功落过资产动的历史条（无 `sourceAssetEffectCents`）删除时不再产生资产行。
- **定时记账关联资产（可选）**：`pages/ledger-schedule-edit` 同样拉取 `listAssetAccounts`，规则上可选 `assetAccountId`；**新建规则时**若账本有默认账户则同样预选；**无资产账户时不展示「资产账户」行**（编辑时若规则仍关联已删除账户则展示）。`createSchedule`/`updateSchedule` 落库到 `ledger_schedules`，`executeScheduleDoc` 入账时走 `insertLedgerTransaction` + `applyLedgerCreateAssetLink`（与记一笔同链路，资产备注侧用「定时记账」文案）。列表页 `listMySchedules` 可展示 `assetAccountName` 便于辨识。
- **定时记账分类选择交互**：`pages/ledger-schedule-edit` 同为底部弹窗 + 铺平网格，且随「支出/收入」切换仅展示对应 `expenseList`/`incomeList`；`status=completed` 时不打开弹窗并保持整行禁用观感。
- **定时记账列表页新增入口**：`pages/ledger-schedules` 底部固定主按钮文案为「新家定时记账」，列表态与空态都可直接进入新建定时任务页。
- **定时记账重复规则**：`pages/ledger-schedule-edit` 支持 `once` / `daily` / `weekly` / `monthly` / **`yearly`**；每年重复在 `ledger_schedules` 存 `yearMonth`（1–12）与 `yearDay`（1–28，与每月同日上限一致），`scheduleLib.computeInitialNextRun` / `advanceAfterRun` 与列表 `recurrenceText`（如「每年3月15日」）一致。
- **月支出预算**：`ledgers.monthlyBudgetCents`（可选，分，自然月支出上限）；由创建者在 `pages/ledger-budget` 或 `components/ledger-detail-view` 标题「⋯」抽屉中维护，云函数 `updateLedgerMonthlyBudget`。
- **账本默认资产账户**：`ledgers.defaultAssetAccountId` / `defaultAssetAccountName`（可选，须为创建者本人非归档户主账户）；由创建者在 `pages/ledger-default-account` 或详情「⋯」抽屉维护，云函数 `updateLedgerDefaultAssetAccount`；`listLedgers` / `getLedger` / `enterLedger` 返回该字段供记一笔与新建定时预选。
- **账本改名入口**：仅创建者可见 `components/ledger-detail-view` 标题栏账本名称右侧「⋯」底部抽屉中的「修改账本名称」；`pages/ledger-manage` 不提供改名入口。
- **多账本列表行**：`listLedgers` 返回每条 `monthIncomeCents` / `monthExpenseCents` / `monthSummaryLabel`（当月北京时间自然月，流水时间 `bookedAt ?? createdAt`；每账本最多 1000 条流水参与汇总，与 `analyzeLedger` 一致）、`pinned`（当前用户置顶偏好）；列表按置顶优先（`pinnedAt` 新在前），其余按 `createdAt` 新在前。`design-exports-v2/jizhang.pen` 画板「01-账本列表」中卡片示意与列表布局对齐。列表卡片右侧仅保留「记一笔」按钮，并在右侧区域上下居中，不再展示「⋯」菜单；置顶账本在标题旁展示「置顶」徽章。
- **账本列表 / 详情底部抽屉与 TabBar**：`pages/ledgers` 多账本列表不再展示「⋯」操作菜单；列表底部固定「查看已归档账本」入口（`pages/ledger-archived-list`，列表用 `ledgers_archived_list_snap_v1` 本地快照先渲染再等 `listLedgers` 覆盖，口径同 `ledgers_list_snap_v1`）。`ledger-detail-view` 标题「⋯」对成员可见。创建者在详情页打开操作抽屉期间隐藏自定义 TabBar（嵌入 Tab 时详情组件 `triggerEvent('hosttabbar')`，由 `pages/ledgers` 消费）；独立打开 `pages/ledger-detail` 时组件内直接 `getTabBar()`。关闭抽屉、`pageLifetimes.hide` 离页或改名/归档/删账本确认弹窗 `complete` 时恢复；列表页 `onShow` 仍按页内 `sheetOpen` 同步 `hidden`。
- **账本归档**：`ledgers.archived === true` 时自日常 `listLedgers`、统计 `scope: "all"`、定时入账等路径排除；**无 `archived` 字段的历史账本按未归档处理**（与 `listAssetAccounts` 的 `_.neq(true)` 口径一致）。仅创建者可 `archiveLedger` 归档/恢复；**`deleteLedger` 须先归档**。详情页已归档时隐藏记一笔、预算、**「统计分析」**入口与邀请码拉取，流水只读；**恢复成功后** `switchTab` 至账本 Tab 列表（`showBillLedgerListOnce = true`）。
- **详情页固定「记一笔」按钮**：`components/ledger-detail-view` 在非 `recordInline` 模式下使用底部 fixed 按钮，默认保持水平居中显示。
- **详情页最近流水分组**：`components/ledger-detail-view` 将 `listTransactions` 结果按记账日期分组展示（今天 / 昨天 / 具体日期 `YYYY-MM-DD`）；**同一日组内**按 `bookedAt ?? createdAt` 倒序（新在上；时刻相同或同毫秒时再用 `createdAt`、最后 `_id` 稳定序）。分组内单条流水不再展示日期，仅在有时分时显示 `HH:mm`；有 `attachments` 时展示缩略图（最多 9，点击预览）。云函数侧 `listTransactions` 按 `createdAt` 倒序拉取至多 **1000** 条（与 `analyzeLedger` 汇总上限一致），再按 `bookedAt ?? createdAt` 排序返回；`txTotalCount > 1000` 时在「最近流水」上方展示琥珀提示条（`txListTruncatedHint`）。
- **协作者管理页拆分**：`pages/ledger-manage` 保留归档/删除入口；微信邀请与协作者列表统一放在 `pages/ledger-collaborators`。
- **协作者邀请卡片样式**：`pages/ledger-collaborators` 的 `onShareAppMessage` 使用自定义标题（含账本名，超长自动截断）+ 固定封面图 `miniprogram/images/LmtpX.png`，分享出去的微信卡片视觉与文案保持稳定。
- **我的页分享入口**：`pages/mine` 新增「分享给朋友」卡片按钮（`open-type="share"`）；`onShareAppMessage` 标题优先带当前昵称，封面图固定 `miniprogram/images/LmtpX.png`。
- **页面分享权限口径**：全局页面默认隐藏微信分享菜单（`wx.hideShareMenu`）；仅 `pages/ledger-collaborators`、`pages/mine` 与 `pages/assets/asset-account-share` 在页面生命周期内放开 `shareAppMessage`。其中资产共享页由户主先创建邀请码，再通过微信分享邀请链接（链接自动携带邀请码）给他人加入。
- **详情协作入口**：`components/ledger-detail-view` 标题「⋯」对账本成员可见：创建者未归档时抽屉含**置顶/取消置顶**（全员）、预算/默认账户/改名/协作者/归档；**已归档**时含恢复/删账本；非创建者未归档时含置顶/取消置顶与「退出账本」（云函数 `exitLedger`）。置顶写入 `ledger_members.pinned` / `pinnedAt`，仅影响本人列表排序（`setLedgerPinned`）。
- **流水改删权限**（云函数侧）：`getTransaction` / `updateTransaction` / `deleteTransaction` 仅允许**该条流水的记录人**；若历史数据无 `createdByOpenid`，仅**账本创建者**可改删（见 `index.js` 顶部注释）。
- **账本 Tab 列表优先**：`globalData.showBillLedgerListOnce` 为 `true` 时，下次 `pages/ledgers/ledgers` 的 `refresh` 会**强制展示账本列表**（即使只有一个账本也不进入内嵌详情）；标志在消费后清零。由 `ledger-detail`、`ledger-manage` 等在删账本等场景内置位。
- **删账本返回落点**：`pages/ledger-manage` 删除账本成功后统一 `switchTab` 到 `pages/ledgers/ledgers`，并清空 `showBillLedgerListOnce`；归档成功则置 `showBillLedgerListOnce = true` 以回到列表。因此仅剩一个未归档账本时会自动进入详情，多个账本时显示列表。
- **账本列表缓存**：`pages/ledgers/ledgers.js` 的 `refresh` 使用 `ledgers_list_snap_v1` 本地键先展示上一屏 `listLedgers` 数据，接口成功后再覆盖并写回缓存；应用缓存时**不**清零 `showBillLedgerListOnce`（与云函数返回后的消费逻辑一致）。
- **账本页多账本引导条**：`pages/ledgers/ledgers` 的“多账本，账目更清晰”banner 在**非加载态始终展示**（单账本内嵌详情 / 多账本列表 / 空账本均显示），点击统一走 `createLedger`。
- **统计范围与记忆**：`pages/ledger-analytics` 默认**全部账本**汇总；顶栏打开底部抽屉可勾选**多个账本合并**、保存**命名统计组合**（本地键 `analyzeStatGroups_v1`），或快捷选「全部账本」。范围记忆 `lastAnalyzeScope_v1`（兼容旧键 `lastAnalyzeLedgerId`：`__ALL__` 或单账本 `_id`）。自定义多选/组合在「月」视图展示**所选账本月预算之和**；「全部账本」仍不展示预算条。失效/已归档账本会自动剔除。单账本统计每本最多 1000 条流水参与计算；`analyzeLedger` / `listGroupTransactions` 超限时返回 `txDataTruncated` / `txDataTruncatedHint`，统计页与下钻页展示琥珀提示条。下钻 `pages/ledger-analytics-drill` 通过 URL `scope=all` / `id=` / `ids=` 与统计范围一致；`listGroupTransactions` 支持 `ledgerIds`，明细行带 `ledgerId`；明细 `timeText` 由云函数按北京时间（`bookedAt ?? createdAt`）格式化，与记一笔展示一致。
- **用户资料设置口径**：`pages/mine` 不依赖 `getUserProfile` 直接同步真实微信资料；点击圆头像触发 `chooseAvatar` 后会先上传云存储并调用 `updateMyProfile` 持久化（头像可单独保存），点击昵称触发弹窗输入并调用 `updateMyProfile` 保存展示名；未设置昵称时，昵称展示与流水页一致，回退匿名 openid（`…` + 后 8 位）。
- **资产域口径（全局）**：资产账户与资产总览不绑定 `ledgerId`；资产页总览固定按 `scope=all` 展示（不再提供「全部资产 / 个人资产 / 共享资产」顶部切换）。共享能力按**账户粒度**（`accountId`）授权：户主可分享到账户成员，**共享成员统一 `viewer` 只读**（不可编辑、不可归档、不可转账、不可分享、不可删户）；共享资产列表按**户主分组**展示，且仅展示共享到账户（不混入个人账户）。
- **账户列表交互**：`pages/assets/asset-accounts` 支持 `scope`：`personal`（本人）/`shared`（共享给我）。顶部仍为 **「未归档」/「已归档」** 分段切换；共享域下列表行带 `shareRole` 与户主信息，且共享列表统一只展示「记录/共享」等只读相关入口，不展示编辑/归档/变动入口。
- **账户编辑页分类联动**：`pages/assets/asset-account-edit` 中「账户分类」选项随「账户属性」过滤——资产仅现金/银行卡/电子钱包/应收款/固定资产/其他；负债仅信用卡/借款/应付款/其他；切换属性时原分类若不在新列表内则回退为「其他」。**无「排序」表单项**；`updateAssetAccount` 仍支持传入 `sortOrder` 以兼容旧数据，但前端不再编辑。
- **变动记录全部账户**：从资产 Tab 总览进「变动记录」未带 `accountId` 时，会携带当前 `scope` 到 `listAssetRecords`：`personal` 仅本人账户、`shared` 仅共享到账户、`all` 合并两者；列表每行展示本侧账户 `accountName`，单账户筛选时不重复展示标题已载明的账户名。
- **资产变动记录只读**：`pages/assets/asset-records` 仅展示，不提供编辑/删除；列表按 `bookedAt ?? createdAt` **倒序**，并按**入账日**分段标签（今日 / 昨日 / `YYYY-MM-DD`），与设计稿「12-资产变动记录」一致的主副色：**减少 `#B42318`，增加 / 调整正向增量 `#0F766E`，转账 `#1D4ED8`**，次级文案 `#64748B` / `#667085`。行样式：首行左侧「账户名 · 变动类型」为中性色（固定深灰 `#101828`）；**仅右上角「¥ ±变动额」按类型设色**（减 / 转出红、增与调整绿、转账蓝）。若为转账且备注仅存「[转账转出/入]」「转账转出/入」等与首行重复语义，则不展示备注行。底行左侧「余额」、右下角入账日期时间。顶栏标题「变动记录」，单账户可调副标题账户名。正文区承接加载中 / 暂无记录 /（仅失败时）错误横幅。**未传 `accountId`** 时由上级入口 URL 携带的 `scope`（`personal` / `shared` / `all`）决定聚合范围（与资产 Tab 快捷「记录」等一致），不设页面内全部/个人/共享切换。**不在本页**提供底部「新增资产变动」——新建变动从单账户页的「调整/变动」等入口进入 `pages/assets/asset-record-edit`。`pages/assets/asset-record-edit` 只用于**新建** `createAssetRecord`：日期+系统 `time` 选**时分**，保存时 `bookedAtMs` 合并**当前秒/毫秒**（与记一笔同口径，便于同分钟内连续多条区分）（若打开时带 `recordId` 会提示并回列表）。记一笔/资产变动/资产转账的日期选择受「不早于该账户 `openedAtMs`/`createdAt`」约束：`miniprogram/utils/asset-account-time.js` 与 `picker mode="date"` 的 `start`、以及提交时 `clampBookedAtMsToFloor` 与云函数一致。云函数 `updateAssetRecord` / `deleteAssetRecord` 恒返回失败，与前端策略一致；错账需通过**新增**变动/调整或转账等修正。
- **资产记录口径（一期）**：先支持 `adjust` / `increase` / `decrease` 三类变动与余额链重算。`rebuildAssetAccountBalanceChain` 从 0 按时间重放全部 `asset_records` 后写回 `asset_accounts.balanceCents`，因此 **新建账户时若期初余额非零**，`createAssetAccount` 会同时落一条「期初余额（开户）」的 `adjust` 记录，**`bookedAt` 与 `openedAtMs`（与开户同一时刻）** 一致，避免首笔记账后重算把开户金额冲掉。云函数在写入侧强制：**同一账户下新产生的 `asset_records.bookedAt` 不得早于该账户的创建时刻**（`openedAtMs` 或 `createdAt`）；`createAssetRecord` / `createAssetTransfer` / 记一笔/编辑流水**关联资产**（`insertLedgerTransaction` + `appendAssetRecordFromLedgerSource`）等路径均校验。旧数据若曾把期初锚在 2000-01-01，在「其余非期初行时间不早于 `createdAt`」可安全对齐时，重算链会把该期初的 `bookedAt` 修正为创建时刻。新建时 `increase/decrease` 可选同步到指定账本分类（分别生成收入/支出流水）。历史行不在客户端改删。
- **资产转账与趋势口径（一期增强）**：支持 `createAssetTransfer`（转出/转入双分录）；转账采用云数据库事务保证双分录与双账户余额原子提交。`pages/assets/asset-transfer` 仅在账户加载失败或提交前校验失败等场景展示 `statusHint` 单行提示（变更转出/转入/金额时可清空）。趋势分两种：**净资产趋势**由 `listNetWorthTrend` 按月返回（优先读取月快照），用于全局资产趋势查看；**单账户余额趋势**由 `listAssetAccountTrend` 从 `asset_records` 实时聚合（按北京时间自然月取每月末最后一条记录的 `afterBalanceCents`，与 `rebuildAssetAccountBalanceChain` 维护的余额链同源，**不复用 `asset_snapshots`**——后者为用户级汇总、无 `accountId` 维度；户主/共享 viewer/归档账户均可只读查看）。`pages/assets/asset-trend` 复用为双模式：无 `accountId` 走净资产趋势，带 `accountId` 走单账户余额趋势（标题/单位/折线颜色随模式与 `account.kind` 切换），均采用「当前值 + 环比 + 近 12 月折线」，仅查询失败时一条错误横幅，不设多块常驻示例状态。
- **资产趋势快照口径**：新增 `asset_snapshots`（按用户+月份存快照）；`listNetWorthTrend` 优先读快照，资产记录/转账变更后自动重建快照，降低趋势查询开销。`rebuildAssetSnapshots` 全量重算时**仅落库最近 200 个自然月**（与 `listNetWorthTrend` 的 `.limit(200)` 一致），月跨度过大时逐月写库易触发云函数默认 20s 时限，故做上限与截断；随期初行改为「开户时刻」、净跨度缩短，可减轻该压力。
- **资产页快捷入口样式**：`pages/assets/assets` 底部操作入口采用单行四宫格（新建账户/记录/账户转账/趋势）；各格图标容器与主色区分开（新建蓝 / 转账青绿 / 趋势琥珀 / 记录紫色），与白底卡片搭配，设计稿对应 `design-exports-v2/jizhang.pen` 画板「10-资产总览」`quick10`。不再使用两行 fixed 按钮；其中「新建账户」直接进入 `pages/assets/asset-account-edit`。仪表盘失败时仅用一条顶部错误横幅承接异常文案（不并排展示多块「预览态」状态）。
- **资产页归档列表入口**：`pages/assets/assets` 页面最下方固定展示「查看已归档资产列表」，进入 `pages/assets/asset-archived-list`。
- **已归档资产列表页**：`pages/assets/asset-archived-list` 通过 `listAssetAccounts(archivedOnly: true)` 分别展示个人归档账户与共享归档账户；行点击进入 `asset-account-detail`（`accountId` / `scope` / `role` 与总览账户行跳转口径一致）。
- **资产总览账户卡片跳转**：`pages/assets/assets` 中个人资产、个人负债、共享分组下的账户行均支持点击，进入 `pages/assets/asset-account-detail` 单账户管理页（携带 `accountId`/`scope`/`role`）。
- **单账户管理页**：`pages/assets/asset-account-detail` **无顶栏「账户」标题**；**已归档**时：顶栏标题带 `（已归档）`、**琥珀提示条**、主卡片**无**记变动/**名称旁 ✎ 编辑**、**不**拉取嵌入变动预览、**不**展示「共享与成员」与「最近变动」；仅「恢复账户」与**「查看账户趋势 ›」**（归档提示条下方独立入口）可用。未归档时：主卡片内记变动、可编辑时在**账户名旁小图标（✎）**进 `asset-account-edit`；**不提供页内转账**；下方（户主）「共享与成员」+「归档」；底部「最近变动」预览，其头部含「趋势」「查看全部 ›」两个入口，「趋势」带 `accountId` 进 `asset-trend`。共享 `viewer` 只读；**趋势为只读查看，户主/共享 viewer/归档账户均可进入**；加载中单行文案，失败横幅；不设多块固定「演示」并排。
- **资产页转账入口口径**：`pages/assets/assets` 的「账户转账」入口固定可进入，并以 `scope=all` 打开 `pages/assets/asset-transfer`；因共享成员统一只读，`all` 下当前仅聚合个人账户供选择，提交仍由云函数 `createAssetTransfer` 做权限校验。
- **我的页跳转体验**：`pages/mine` 的「分类管理」「定时记账」点击后直接跳转目标页，不在我的页预加载；加载态由 `pages/ledger-categories`、`pages/ledger-schedules` 各自承担。
- **自定义 TabBar 视觉**：`miniprogram/custom-tab-bar` 的立体感优先用 `box-shadow`（`tabbar-pill`、`tab-item-active`）实现，不新增额外覆盖层，避免遮挡点击区域；改 Tab 视觉时优先在该目录调整，避免影响 Tab 选中同步逻辑。
- **Tab 选中态口径**：`selected` 由四个 Tab 页在 `onShow` 明确写入固定索引（账本=0、统计=1、资产=2、我的=3）；`miniprogram/custom-tab-bar/index.js` 不再基于 `getCurrentPages()` 做 route 同步，避免切 Tab 过渡期读到旧路由导致“抖”。组件在点击 Tab 时会先即时 `setData({ selected })`，视觉更快，最终以页面 `onShow` 为准。

## 云函数与调度

- 入口：`cloudfunctions/ledgerFunctions/index.js` → `exports.main`。
- 定时触发：`cloudfunctions/ledgerFunctions/config.json` → `ledgerScheduleTimer`，Cron `0 0 3 * * * *`（每天北京时间约 3:00）；`nextRunAt` 按日历日（北京时间 0 点）在 `scheduleLib.js` 计算，保存后若已到期会在 `createSchedule`/`updateSchedule` 内立即尝试入账。

`type` 与实现分支对应（维护时请与 `switch (type)` 保持一致）：

- 账本：`createLedger`、`listLedgers`（可选 `archivedOnly`）、`setLedgerPinned`（成员设置本人置顶偏好）、`archiveLedger`、`updateLedgerName`、`updateLedgerMonthlyBudget`、`updateLedgerDefaultAssetAccount`、`getLedger`、`deleteLedger`（须已归档）
- 协作：`enterLedger`、`joinLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`reviewJoinRequest`、`removeCollaborator`、`exitLedger`
- 分类与流水：`listCategories`、`addLedgerCategory`、`removeLedgerCategory`、`listTransactions`、`addTransaction`、`getTransaction`、`updateTransaction`、`deleteTransaction`
- 统计：`analyzeLedger`（`groups` / `groupsByPerson` 为**支出**维度的排行；汇总净额等仍含收支；另含 `trendPoints`、`pieGroups*` 等；`scope: "all"` 汇总全部可访问未归档账本；`ledgerIds: string[]` 自定义合并多账本（月预算求和）；或单账本 `ledgerId`；全量 `scope: "all"` 不返回月预算对比）、`listGroupTransactions`（`scope: "all"` 或 `ledgerIds`；明细行带 `ledgerId`）
- 定时：`listMySchedules`、`createSchedule`、`getSchedule`、`updateSchedule`、`deleteSchedule`
- 用户资料：`getMyProfile`、`updateMyProfile`
- 资产（全局）：`createAssetAccount`、`listAssetAccounts`（支持 `scope: "personal"|"shared"`）、`getAssetAccount`、`updateAssetAccount`、`archiveAssetAccount`、`deleteAssetAccount`（仅户主可删，且该户无任何 `asset_records` 时可删库；**小程序不调用**）、`getAssetDashboard`（支持 `scope: "all"|"personal"|"shared"`；成功时可读 `monthOverPrevMonthNetWorthPct`：快照月相邻两格的净资产环比，供总览徽章展示）
- 资产记录：`createAssetRecord`、`listAssetRecords`（支持 `scope: "personal"|"shared"|"all"` 的无 `accountId` 聚合口径）、`getAssetRecord`（`getAssetRecord` 暂未被小程序调用）——`updateAssetRecord` / `deleteAssetRecord` 仍挂 `type` 但恒失败（历史只读）
- 资产转账/趋势：`createAssetTransfer`、`listNetWorthTrend`（用户级净资产趋势，读 `asset_snapshots`）、`listAssetAccountTrend`（单账户余额趋势，实时聚合 `asset_records`，户主/共享 viewer/归档账户均可只读）
- 资产共享（按账户）：`createAssetAccountShareInvite`、`enterAssetAccountShare`、`listAssetAccountShareMembers`、`updateAssetAccountShareMemberRole`、`removeAssetAccountShareMember`、`exitAssetAccountShare`

## 云数据库集合（概念）

与 `COLLECTION_NAMES` 一致（细节以 `index.js` 注释与代码为准）：

- `ledgers`、`ledger_members`、`ledger_join_requests`、`ledger_invites`
- `transactions`、`ledger_schedules`、`user_profiles`
- `asset_accounts`、`asset_records`、`asset_account_shares`、`asset_account_share_invites`
- `asset_snapshots`

## 页面（`miniprogram/app.json`）

**Tab 页**（与 `custom-tab-bar` 中 `pagePath` 一致）：

- `pages/ledgers/ledgers` — 账本（列表 / 入口；文案与 `app.json` tabBar、`custom-tab-bar` 一致）  
- `pages/ledger-analytics/ledger-analytics` — 统计  
- `pages/assets/assets` — 资产（全局资产总览，独立于账本）
- `pages/mine/mine` — 我的  

**其它业务页**（节选）：`ledger-detail`（单账本主页）、`ledger-manage`（账本归档/删除）、`ledger-archived-list`（已归档账本列表）、`ledger-collaborators`（微信邀请与协作者列表）、`ledger-categories`、`ledger-budget`、`ledger-default-account`、`ledger-tx`、`ledger-analytics-drill`、`ledger-schedules`、`ledger-schedule-edit`、`assets/asset-archived-list`、`assets/asset-accounts`、`assets/asset-account-detail`、`assets/asset-account-edit`、`assets/asset-account-share`、`assets/asset-records`、`assets/asset-record-edit`、`assets/asset-transfer`、`assets/asset-trend`。

`app.json` 里 **`pages` 数组第一项**为小程序冷启动首屏（当前为 `ledgers`）；后续按 Tab 顺序依次为 `ledger-analytics`、`assets`（及资产子页）、`mine`。

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
- 调整统计展示或口径：先改云函数聚合返回，再改 `pages/ledger-analytics/*` 与 `pages/ledger-analytics-drill/*`；统计范围本地记忆与 URL 拼装见 `miniprogram/utils/analyze-scope.js`。
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
