# 协同记账（微信小程序 + 云开发）

微信原生小程序项目，核心能力包括：多账本、成员协作（邀请码/加入申请/审批）、流水与分类管理、全局资产管理、统计分析（AntV F2）和定时记账（云函数定时触发）。

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
- `miniprogram/app.js` 会在 `onLaunch` 自动注册 `UpdateManager`：检测到新版本后弹窗提示用户重启应用，下载失败时给出轻提示。
- `miniprogram/app.json` 已启用分包：主包仅保留 4 个 Tab 页（账本/统计/资产/我的）；其余业务页按目录拆到多个 `subPackages.root`（如 `pages/ledger-detail`、`pages/ledger-manage`、`pages/ledger-collaborators` 等），用于控制主包大小不超过 2MB。
- `miniprogram/app.json` 已配置 `preloadRule`：进入任一 Tab 页后，在 `all` 网络下预下载上述业务分包，进一步降低首次进入业务页的等待时间。
- `project.config.json` 的 `packOptions.ignore` 已忽略 `node_modules` 与未使用的大图素材（路径以 `miniprogramRoot` 为根），避免上传时把本地依赖和演示资源打进代码包。
- 前端调用统一走：
  - `wx.cloud.callFunction({ name: "ledgerFunctions", data: { type: "..." } })`

## 开发前检查（建议）

- 确认 `miniprogram/app.js` 的 `globalData.env` 指向当前开发环境。
- 确认云函数已在微信开发者工具上传最新版 `ledgerFunctions`。
- 如果改统计图依赖，先执行 `cd miniprogram && npm install`，必要时执行 `npm run vendor:f2` 同步运行时。
- 如果改了接口入参，先对照 `cloudfunctions/ledgerFunctions/index.js` 的 `switch(type)` 与页面调用处。
- 统计页选择「全部账本」或某一账本，会记录到本地缓存 `lastAnalyzeLedgerId`：值为**账本 `_id`** 或**字面量 `__ALL__`（表示汇总全部可访问账本）**；**默认**为 `__ALL__`（全量统计）。若已保存的账本已删除/无权限，会回退为「全部账本」汇总，避免报错。
- 账本页（`pages/ledgers/ledgers`）的多账本介绍 banner 在**非加载态始终展示**，不再按账本数量决定显隐。
- 新建/空账本的默认分类为 **18 个支出** + **6 个收入**（支出含餐饮/三餐/买菜/交通等；收入含工资、奖金、理财、收租、红包、其他收入等），合计预置 24 个，单账本分类总数上限为 **48**；`listCategories` 会随迁移为旧账本**补全**预置收入类。云函数会区分收支：`listCategories` / `getTransaction` / `getLedger` / `enterLedger` 均额外返回 `expenseList` 与 `incomeList`；记一笔、定时、资产侧同步到账本时按当前选「支出/收入」只使用对应子列表。自定义新分类在「分类管理」和记一笔里通过 `addLedgerCategory` 传入 `forFlow: 'expense'|'income'`，并写入账本文档可选字段 `categoryByFlow`；未打标的旧自定义名在收支两侧均可选（`both`）。`addTransaction` 等会校验分类与 `flow` 一致。
- 分类显示层支持“分类名前 icon”映射（见 `miniprogram/category-icons.js`）：新增分类时可点选 icon 网格或输入自定义 emoji（emoji 优先）；保存值为“emoji + 分类名”文本，兼容历史流水与统计口径。
- 记一笔页（`components/ledger-tx-form`）分类选择从系统 `picker` 改为底部弹窗：主表单仅展示当前分类与入口，弹窗内铺平双列网格（可滚动），长分类名与 emoji 分类可完整阅读。顶部「支出 / 收入」在分段上直接点选切换，不弹系统选单。日期与**时刻**用两个系统 `picker`（`date` + `time`）选择，`bookedAtMs` 带完整毫秒；确认记账时用当前秒/毫秒写入以区分同分钟内连续多条。可选「资产账户」关联当前用户 `listAssetAccounts` 中的非归档账户，默认不关联；**若无任何非归档资产账户则不展示资产账户表单项**（编辑已关联但账户已删除的流水时仍会展示以便调整）。保存时 `addTransaction` 会写入 `transactions` 的资产快照字段，并在**成功**后追加一条 `asset_records` 并调整账户余额；编辑/删除流水时资产侧**再各记一条**变动（`sourceOperation` 为 `ledger_update` / `ledger_delete` 等，附账本 id/名称与流水 id），用于冲销或差额调整。资产变动记录列表中的「备注」会包含上述说明（与 `sourceChangeSummary` 等字段一致）。
- 定时记账页（`pages/ledger-schedule-edit`）分类选择同样为底部弹窗 + 铺平网格，沿用同一套「icon + 分类名」显示口径；一次性任务 `status=completed` 时不打开弹窗。可选「资产账户」与记一笔同数据源（`listAssetAccounts` 非归档），`createSchedule` / `updateSchedule` 写入规则上的 `assetAccountId` / `assetAccountName`；**无资产账户时不展示资产账户行**（编辑时规则仍关联已删除账户除外）。定时**执行入账**时按记一笔同口径写流水并联动 `asset_records`（资产行备注/摘要为「定时记账」相关文案）。
- 定时记账列表页（`pages/ledger-schedules`）底部提供固定主按钮「新家定时记账」，列表态与空态都可直接发起新建。
- 我的页资料采用手动设置：点击圆头像触发 `chooseAvatar` 后会先上传云存储并调用 `updateMyProfile` 持久化（可只更新头像），点击昵称触发输入弹窗并保存；不依赖 `getUserProfile` 返回真实微信昵称。未设置昵称时，昵称展示与流水一致，回退为匿名 openid（`…` + 后 8 位）。
- 我的页的「分类管理」「定时记账」入口点击后直接跳转，不在 `pages/mine` 预加载；目标页内自行展示 loading/加载态。
- 资产页（`pages/assets/assets`）底部功能入口改为单行四宫格快捷区：每个入口均为“图标在上 + 名称在下”的可点击区域（账户管理/变动记录/账户转账/净资产趋势），并取消原先两行 fixed 按钮。
- 自定义 TabBar 的立体感仅通过 `box-shadow` 增强：不新增额外覆盖层，避免影响点击区域；样式集中在 `miniprogram/custom-tab-bar/index.wxss` 的 `tabbar-pill` 和 `tab-item-active`。选中态由四个 Tab 页在 `onShow` 显式写入固定索引（账本=0、统计=1、资产=2、我的=3）；`custom-tab-bar` 不再基于 route 做自动同步，点击 Tab 时先即时 `setData({ selected })`，最终以页面 `onShow` 为准。
- 分享入口口径：全局页面默认隐藏微信分享菜单（`wx.hideShareMenu`），仅 `pages/ledger-collaborators` 与 `pages/mine` 放开 `shareAppMessage`；前者用于邀请协作者，后者提供“分享给朋友”卡片入口（`open-type="share"`）。

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
  - `getLedger` -> `pages/ledger-manage`、`pages/ledger-collaborators`、`components/ledger-detail-view`（`ledger` 下含 `expenseList` / `incomeList`）
  - `updateLedgerName` -> `components/ledger-detail-view`
  - `updateLedgerMonthlyBudget` -> `pages/ledger-budget`
  - `deleteLedger` -> `pages/ledger-manage`、`components/ledger-detail-view`（详情标题「⋯」抽屉）
- **协作**
  - `enterLedger` -> `components/ledger-detail-view`
  - `createLedgerInvite` -> `pages/ledger-collaborators`、`components/ledger-detail-view`
  - `listLedgerCollaborators` -> `pages/ledger-collaborators`、`components/ledger-detail-view`（每个成员/待审批项含 `avatarUrl`）
  - `reviewJoinRequest` -> `pages/ledger-pending`
  - `removeCollaborator` -> `pages/ledger-collaborators`
  - `exitLedger` -> `components/ledger-detail-view`
- **分类与流水**
  - `listCategories` -> `pages/ledger-tx`、`pages/ledger-categories`、`pages/ledger-schedule-edit`、`pages/assets/asset-record-edit`；成功时除 `list` 外有 `expenseList`、`incomeList`
  - `addLedgerCategory` / `removeLedgerCategory` -> `pages/ledger-categories`、`components/ledger-tx-form`（`add` 时可选 `forFlow`，与自定义分类绑定收支；成功时同样返回 `expenseList`/`incomeList`）
  - `listTransactions` -> `components/ledger-detail-view`（流水项含 `payerAvatarUrl`，用于“头像+昵称”展示）
  - `getTransaction` -> `pages/ledger-tx`（除 `categories` 外有 `expenseList`、`incomeList`）
  - `addTransaction` / `updateTransaction` / `deleteTransaction` -> `components/ledger-tx-form`（`addTransaction` / `updateTransaction` 可选入参 `assetAccountId`：空为不关联；成功关联时会写 `asset_records` 与 `sourceAssetEffectCents`；`updateTransaction` / `deleteTransaction` 在资产侧追加变动记录以冲销或按差额调整；旧客户端改流水不传 `assetAccountId` 时云函数不改动原有关联与资产行）
- **统计**
  - `analyzeLedger` -> `pages/ledger-analytics`；入参可传 `scope: "all"` 汇总用户全部可参与账本，否则传 `ledgerId` 单本分析（`groupsByPerson` 项含 `avatarUrl`）
  - `listGroupTransactions` -> `pages/ledger-analytics-drill`（明细项含 `payerAvatarUrl`；`scope: "all"` 时汇总全部可访问账本，各条带 `ledgerId` 以便跳转记一笔）
- **定时**
  - `listMySchedules` -> `pages/ledger-schedules`
  - `getSchedule` / `createSchedule` / `updateSchedule` / `deleteSchedule` -> `pages/ledger-schedule-edit`（部分状态切换也在 `pages/ledger-schedules`；`getSchedule` 的 `raw` 与 `listMySchedules` 的列表项可含 `assetAccountName`；`createSchedule` / `updateSchedule` 可选入参 `assetAccountId`：空串表示不关联，`updateSchedule` 仅在传入该字段时改关联）
- **用户资料**
  - `getMyProfile` / `updateMyProfile` -> `pages/mine`
- **资产（全局）**
  - `createAssetAccount` -> `pages/assets/asset-account-edit`（期初非零时云函数会追加「期初余额（开户）」`asset_records`，`bookedAt` 为开户时刻；**同一账户下**新写入的 `asset_records` 的 `bookedAt` 云函数要求不早于该账户的创建时间）
  - `listAssetAccounts` -> `pages/assets/asset-accounts`、`pages/ledger-tx`、`pages/ledger-schedule-edit`（可选入参 `archivedOnly: true` 仅查已归档，供账户列表「已归档」页；记一笔/定时/转账等默认未归档。记一笔/定时任务可选关联本人**非归档**资产账户；**返回顺序**为当前余额 `balanceCents` **降序**，同额按 `updatedAt` 新在前。另：仅传 `includeArchived: true` 且**未**传 `archivedOnly` 时仍为含归档的**全部**，兼容旧版）
  - `getAssetAccount` -> `pages/assets/asset-account-edit`
  - `updateAssetAccount` -> `pages/assets/asset-account-edit`
  - `archiveAssetAccount` -> `pages/assets/asset-accounts`（`deleteAssetAccount` 云函数保留：无 `asset_records` 时可物理删除；**小程序未接入口**）
  - `getAssetDashboard` -> `pages/assets/assets`（资产/负债分栏内账户均按**余额降序**）
  - `createAssetRecord` -> `pages/assets/asset-record-edit`（`increase/decrease` 可选同步到指定账本分类）
  - `listAssetRecords` -> `pages/assets/asset-records`
  - `getAssetRecord` / `updateAssetRecord` / `deleteAssetRecord`：云函数仍暴露 `type`，其中 `updateAssetRecord` / `deleteAssetRecord` 恒返回“仅可查看”类错误（与小程序只读策略一致；`getAssetRecord` 保留供扩展，当前小程序未调用）
  - `createAssetTransfer` -> `pages/assets/asset-transfer`
  - `listNetWorthTrend` -> `pages/assets/asset-trend`

## 页面索引（页面 -> `type`）

- `pages/ledgers/ledgers`
  - `listLedgers`、`createLedger`（非加载态始终展示多账本介绍 banner）
  - `listLedgers` 每条账本含：`monthIncomeCents` / `monthExpenseCents`（当前北京时间自然月，流水时间 `bookedAt ?? createdAt`）、`monthSummaryLabel`（如 `2026年4月`）、`monthlyBudgetCents`（可选）；单账本流水超过 1000 条时与 `analyzeLedger` 一样仅以前 1000 条参与汇总。
  - 多账本列表：卡片展示当月收入/支出；列表卡片右侧仅保留「记一笔」并上下居中，不再展示「⋯」菜单。
  - 本地快照：`wx.setStorageSync('ledgers_list_snap_v1', { list })` 缓存上次 `listLedgers` 结果；`refresh` 时若无缓存则全屏加载，有缓存则先渲染列表再等云函数返回更新（不提前消费 `showBillLedgerListOnce`）。
- `pages/ledger-manage/ledger-manage`
  - `getLedger`、`deleteLedger`
  - 用于账本管理入口与删除账本；协作者相关功能已拆分到独立页面。
  - 账本管理页不再提供“修改账本名称”入口；改名在账本详情标题「⋯」抽屉中操作。
  - 删除账本成功后统一 `switchTab` 回 `pages/ledgers/ledgers`，并清空 `showBillLedgerListOnce`；若仅剩一个账本将自动进入内嵌详情，多个账本则展示列表。
- `pages/ledger-collaborators/ledger-collaborators`
  - `getLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`removeCollaborator`
  - 提供微信分享邀请和协作者列表管理，待审批入口跳转到 `pages/ledger-pending`；与 `pages/mine` 一起属于允许分享的页面。
  - `onShareAppMessage` 自定义邀请卡片标题与封面图：标题使用「邀请你加入『账本名』一起记账」，封面图固定 `miniprogram/images/LmtpX.png`，并对超长账本名做截断避免分享文案被系统硬截断。
- `components/ledger-detail-view`
  - `enterLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`getLedger`、`updateLedgerName`、`deleteLedger`、`exitLedger`、`listTransactions`
  - 标题栏账本名称右侧「⋯」对成员可见：创建者抽屉包含预算设置/修改名称/协作者管理/删除账本，非创建者仅显示「退出账本」；删除或退出成功后都会 `triggerEvent('deleted')`。
  - 嵌入 `pages/ledgers`（`record-inline`）时抽屉打开/关闭及删账本确认弹窗通过 `bind:hosttabbar` 同步自定义 TabBar 显隐。
  - 非 `record-inline` 模式下，底部 fixed「+ 记一笔」按钮保持水平居中显示。
  - 最近流水在前端按日期分组渲染：当日分组显示“今天”、前一日显示“昨天”、更早记录显示具体日期（`YYYY-MM-DD`）；**同一日组内**为时间倒序（新在上，同刻用 `createdAt` 与 `_id` 作次序）；分组内单条流水不再重复展示日期，仅保留时间（有时分时展示 `HH:mm`）。
  - 本地快照：`wx.setStorageSync('ledger_detail_snap:${ledgerId}', …)` 写入 `listTransactions` 的原始流水数组及账本元信息；下次进入同一账本先展示缓存，接口返回后再刷新。首屏 `enterLedger` 完成至流水返回前展示 `miniprogram/images/ledger-detail-loading.png` 加载插图（源稿：`design-exports-v2/jizhang.pen` 画板「插画-加载中-账本」），避免误显示「暂无记录」空态插画。
- `pages/ledger-tx/ledger-tx` / `components/ledger-tx-form`
  - `listCategories` + `listAssetAccounts`（非归档账户列表，用于可选关联；账户行带 `openedAtMs`/`createdAt` 供「记账日期」`picker` 下限）、`getTransaction`、`addTransaction`、`updateTransaction`、`deleteTransaction`、`addLedgerCategory`；分类按当前「支出/收入」使用 `expenseList` / `incomeList`（全量 `list` 作兼容回退），内联 `addLedgerCategory` 带 `forFlow`。
  - 关联资产为可选项，默认不关联；已选资产时记账日期的可选范围不早于该户创建时间（`miniprogram/utils/asset-account-time.js`）。`listTransactions` 返回的流水可含 `assetAccountName` 快照，详情 `ledger-detail-view` 在左侧主文案中以 `· 账户名` 形式附在分类信息之后。
- `pages/ledger-categories/ledger-categories`
  - `listLedgers`（无 `id` 入参直达时先解析可用账本）、`listCategories`、`addLedgerCategory`（带 `forFlow`）、`removeLedgerCategory`；行内展示分类「收入/支出/通用」标签
- `pages/ledger-analytics/ledger-analytics`
  - `listLedgers`、`analyzeLedger`（单账本 `ledgerId` 或全量 `scope: "all"`；本地 `lastAnalyzeLedgerId` 为 `__ALL__` 时走全量）
- `pages/assets/assets`
  - `getAssetDashboard`（全局资产总览，不绑定账本；资产/负债分栏内账户**按余额降序**）
  - 底部操作区为单行快捷入口（图标上、文案下）：账户管理 / 变动记录 / 账户转账 / 净资产趋势。
- `pages/assets/asset-accounts`
  - `listAssetAccounts`（`archivedOnly: true` / 未传）、`archiveAssetAccount`
  - 顶部「未归档」「已归档」分段切换为**两个独立列表**；未归档对应 `listAssetAccounts` 默认条件，已归档对应 `archivedOnly: true`。
  - 卡片右上角徽章「资产」「负债」：**资产**绿色系、「**负债**」红色系区分。
  - 账户信息区可浏览，不响应点击进入编辑；卡片右侧「资产变动/调整」进入 `asset-record-edit` 新建记录；底部操作条含「编辑」进入 `asset-account-edit`、`归档/恢复`（不再提供删除入口；不需要的账户请归档）。
  - 列表顺序与云函数 `listAssetAccounts` 一致：按**余额从高到低**。
- `pages/assets/asset-account-edit`
  - `createAssetAccount`、`getAssetAccount`、`updateAssetAccount`；**账户分类**随 **账户属性**（资产/负债）切换：只展示与当前属性匹配的分类（如资产不含信用卡/借款等；负债不含现金/银行卡等），切换属性时若当前分类不适用则自动回退为「其他」。
  - 不提供「排序」表单项；新建时由云函数写入默认 `sortOrder`（库字段，仅兼容；展示顺序不依赖它）。
- `pages/assets/asset-records`
  - `listAssetRecords`；变动列表**只读**（无改删入口；云函数 `updateAssetRecord` / `deleteAssetRecord` 亦恒失败），按 `bookedAt ?? createdAt` 倒序展示、行内时间至**秒**；新建变动入口在 `asset-accounts` 卡片的「资产变动/调整」→ `asset-record-edit`；未传 `accountId` 为全部账户时，列表行展示该条 `accountName`（云函数对每条记录补充本侧账户名称，与转账对端 `counterpartyAccountName` 并存）。
- `pages/assets/asset-record-edit`
  - 仅 `createAssetRecord`（新建；`increase/decrease` 可选同步到账本分类）。`listCategories` 的选项：`increase` 仅 `incomeList`，`decrease` 仅 `expenseList`。记账时间：`date`+`time` 选**时分**，`bookedAtMs` 带保存瞬间**秒/毫秒**（与 `ledger-tx-form` 一致）；日期不早于 `getAssetAccount` 的创建时间，提交时再与云函数下限做一次 `clamp`。若 URL 带 `recordId`（旧链或手输），会提示并回退到 `asset-records`。
- `pages/assets/asset-transfer`
  - `listAssetAccounts`、`createAssetTransfer`；日期的 `start` 为转出/转入两户创建时间的**较晚者**（公历日），`bookedAtMs` 在提交时 `clamp` 到不早于任一户。
- `pages/assets/asset-trend`
  - `listNetWorthTrend`
  - 资产转账口径：`createAssetTransfer` 采用云数据库事务写入双分录与双账户余额，失败会整体回滚。
  - 趋势性能口径：`listNetWorthTrend` 优先读取 `asset_snapshots` 月快照；`createAssetRecord` / 新建转账等变更后会自动重建当前用户快照。重建时**仅落库最近 200 个自然月**（与 `listNetWorthTrend` 的返回上限一致），避免月跨度过大时云函数超时（默认 20s）。
- `pages/ledger-analytics-drill/ledger-analytics-drill`
  - `listGroupTransactions`
- `pages/ledger-schedules/ledger-schedules`
  - `listMySchedules`、`updateSchedule`（启停）
  - 页面底部固定主按钮「新家定时记账」统一走 `onAdd` 跳转到新建页
- `pages/ledger-schedule-edit/ledger-schedule-edit`
  - `listLedgers`、`getSchedule`、`listCategories`（`expenseList`/`incomeList` 与收支柱联动）、`listAssetAccounts`（与规则关联资产，非归档账户）、`createSchedule`、`updateSchedule`（可传 `assetAccountId`）、`deleteSchedule`
- `pages/mine/mine`
  - `listLedgers`、`getMyProfile`、`updateMyProfile`、`createLedger`
  - 页面内新增“分享给朋友”卡片按钮（`open-type="share"`），分享卡片标题会优先使用当前昵称，并统一使用 `miniprogram/images/LmtpX.png` 作为封面图。

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
- 改空状态视觉：优先复用已有插画资源；`components/ledger-detail-view` 的“最近流水空状态”与 `pages/ledger-schedules` 共用 `miniprogram/images/LmtpX.png`，且两处空态插图都支持点击直达新增入口（前者进“记一笔”，后者进“新建定时任务”）；`components/ledger-detail-view` 与 `pages/ledger-categories` 的加载态都用 `miniprogram/images/ledger-detail-loading.png`（勿与空态混淆）
- 改 Tab 行为：优先改 `miniprogram/custom-tab-bar/*`（包含选中态同步与显隐）；业务页仅在需要临时遮挡时调用 `getTabBar().setData({ hidden })`

## 提测前自检清单

- 账本主链路：创建账本 -> 进入账本 -> 新增流水 -> 编辑/删除流水。
- 协作链路：邀请码加入/申请审批/移除成员（至少验证一条）。
- 统计链路：月/年切换、分类与成员排行、明细下钻是否与流水一致。
- 定时链路：创建规则、启停规则、编辑规则后 `nextRunAt` 行为是否符合预期。
- 我的页面：资料更新与账本概览（已加入数量/空态新建）是否生效。
- 我的页面资料：仅选择头像后再次进入仍能回显；输入昵称后 `getMyProfile` 回显应与 `updateMyProfile` 保存值一致。
- 若改了路由或 Tab：验证四个 Tab 选中态与返回逻辑（含 `showBillLedgerListOnce` 场景）。

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

