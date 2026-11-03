# Life-OS 架构设计 v0.1

> 目标：把 `digital-life-core` 从"单体插件"变成"数字生命操作系统"，让第三方（以及未来的 AI 自己）能长出新器官。
> 状态：**设计定稿待评审**。本文只定契约与边界，不包含完整实现。

---

## 0. 一句话结论

我们不是在"再加几个工具"，而是在定义**四层结构**：

```
┌──────────────────────────────────────────────────────────────┐
│  L3  Evolution WebUI      观测 / 展示橱窗 / 生态可视化          │
├──────────────────────────────────────────────────────────────┤
│  L2  Life-Organ 生态      memory · vision · shell · db · …    │
│      （第三方或 AI 自己编写，只依赖 ABI，不依赖宿主）            │
├──────────────────────────────────────────────────────────────┤
│  L1  Organ Host           装载 / 能力授权 / 能量会计 / 遥测      │
│      （本次新增，住在 digital-life-core 内部）                  │
├──────────────────────────────────────────────────────────────┤
│  L0  生理底座             能量 · 多巴胺/皮质醇 · 缺口张力        │
│                           意志 · 承诺 · 梦境 · 疤痕            │
│      （已完成，v0.8.1，不动）                                   │
└──────────────────────────────────────────────────────────────┘
```

**关键判断：L0 已经是对的，本次一行不改。** 所有新增复杂度都压在 L1，因为它才是"操作系统"该待的地方——内核稳定，驱动在外。

---

## 1. 为什么不能靠"多写几个工具"解决

工具和器官的差别不是命名，是**责任**：

| 维度 | 工具（现状） | 器官（目标） |
|---|---|---|
| 谁负责花钱 | 核心统一按请求扣 2 点 | 器官自己报价、自己付账、饿了自己罢工 |
| 谁能改状态 | 工具可以任意调 `set_state` | **只能** `feedback()` 提议，宿主统一 clamp + 去重 + 落盘 |
| 谁能进提示词 | 核心写死几段内省文本 | 器官各自申报片段，带 order / ttl / confidence |
| 坏掉会怎样 | 一个工具写错就把整轮搞崩 | 宿主捕获并降级该器官，其余照常 |
| 谁能装 | 必须改核心源码 | 任何人实现 ABI 即可，核心不认识它 |

一句话：**工具是"手脚"，器官是"会自己花钱、会自己难受的器官"。** 后者才需要免疫系统。

---

## 2. ABI：五个成员与三条不可让渡的约束

接口定义见 `src/life-organ.ts`（已通过 `tsc --strict` 检查）。

### 2.1 五个必备成员

| 成员 | 契约含义 | 反例（会被评审打回） |
|---|---|---|
| `name` | 唯一标识，同时是工具命名空间 `organ:<name>:<tool>` 的前缀 | 用大写或中文；两个器官重名 |
| `onLoad(ctx)` | 接上身体：注册工具、订阅结果、申请定时器。**只能通过门面** | 在 onLoad 里直接读 `ctx.get('llm')` 自己改 temperature |
| `consumeEnergy(amount)` | 为本次感知付账，拿到回执决定是否继续 | 自己改能量字段；或干脆不付 |
| `feedback(stimulus)` | 把刺激翻译成 Δ多巴胺 / Δ皮质醇 / 缺口提议 | 返回绝对值；或提议 20 条缺口 |
| `getPromptContext()` | 把"我感知到了什么"压成一小段文本 | 把 5000 字 OCR 结果塞进提示词 |

### 2.2 三条约束（写进文档，也写进运行时）

- **C1 器官永不直接写状态。** 只能 `feedback()` 提议，宿主统一应用。
  *为什么*：如果第三方插件能直接写 `energy`，0–100 的边界、张力上限、疤痕的不可逆性全部失效——那个"生理"就不是生理，是字符串。
- **C2 器官必须为自己的感知付能量，且允许被拒绝。**
  回执 `EnergyReceipt` 有明确状态机：`full | partial | starved | shadow`。`denied=true` 时器官必须**立刻放弃这次感知**，返回空 feedback。
  *为什么*：这是整个内感受循环的可信度来源。不付账的器官 = 白嫖的感官 = 没有生存压力。
- **C3 器官的错误不得传播。** `defineOrgan()` 在 `feedback` / `getPromptContext` 外层兜了 try/catch，异常时把 `health.status` 转 `degraded` 并返回空结果。
  *为什么*：一个视觉插件数组越界，不该让整条生命停摆。

### 2.3 为什么 `ctx` 是门面，不是裸 cordis ctx

裸 ctx 能 `on('llm/stream')`、能 `tools.register` 全量、能拿别的插件的服务。如果器官拿到它，ABI 就形同虚设——**第三个插件可以直接改采样参数、可以自己扣能量、可以读别人的状态**。

`OrganContext` 只暴露"感官与手脚"：

```
state（只读视图） · consume · emit · proposeGap
onToolResult · onTick · registerTool · onPrompt · kv · log
```

其中 `kv` 是器官私有持久化（`~/.dsh/digital-life-core/organs/<name>.json`），防止器官把垃圾写进核心 `state.json`。

---

## 3. 能量会计：迁移期最大的坑

现状是**核心按请求收费**（每次模型请求 -2）。如果器官再按调用收一次，同一件事会被扣两遍——一个"记忆召回"会变成 -4。这会悄悄把能量经济改掉，而且是**无声的**。

所以 `EnergyQuote.chargeMode` 有两个值：

| 模式 | 行为 | 用在哪 |
|---|---|---|
| `shadow`（默认） | 只记账、不真扣。数字仍进遥测，WebUI 的"器官能耗榜"照样能画 | 迁移期，校准器官成本 |
| `additive` | 真扣。核心停止按请求计费后启用 | 终态 |

**路线**：先全量 `shadow` 跑一周 → 看遥测得出真实成本分布 → 核心把 `costPerRequest` 降为 0、只保留器官计费 → 逐个器官翻成 `additive`。

这条路线的好处：任何一步都能回滚，且**永远不存在双重计费的窗口**。

### 饥饿降级是特性，不是故障

`starved` 的器官不是"挂了"，是"累了"。语义上应该表现为：
- 视觉器官不再注入新画面，只保留最后一次的残影（`ttlMs` 到期后自然消失）
- 记忆器官不再检索，只在提示词里留一句"我记不起刚才要查什么"

这恰好是我们想看到的**资源约束下的行为退化**，别把它当 bug 修掉。

---

## 4. Organ Host 的职责边界

宿主住在核心内部，是唯一有权写状态的角色。它要做六件事：

1. **装载与拓扑排序**：按 `requires` 排；检测环依赖；同名冲突直接拒绝。
2. **能力授权**：把 `manifest.capabilities` 编译成允许列表。器官调了没声明的东西 → 抛 `CapabilityDeniedError`，不是静默忽略。
3. **刺激翻译**：把宿主事件翻译成中性 `OrganStimulus`
   | 宿主事件 | 翻译为 |
   |---|---|
   | `tools/post-execute` | `{ kind:'tool:result', tool, ok, text, structured }` |
   | 一轮结束 | `{ kind:'turn:end', text }` |
   | `ctx.interval` | `{ kind:'tick', everyMs }` |
   | 器官自己 `emit()` | `{ kind:'custom', topic, payload }` |
4. **反馈仲裁**：把多个器官的 Δ 值**累加后一次性应用**，再 clamp。逐条 apply 会让后面的器官看到前面的结果，产生顺序依赖——那就不叫"并行器官"了。
5. **提示词拼装**：收集所有 `getPromptContext()`，按 order 排序，过滤过期（ttl）与低置信度，最后统一拼进 `digital-life:endocrine` 之后的槽位。**疤痕永远在 -1e4，器官不得低于 -1000。**
6. **遥测**：每次 feedback / 每次扣费 / 每次降级，写进环形缓冲（默认 2000 条），供 WebUI 与审计使用。

---

## 5. 安全模型（第三方代码 = 不可信代码）

| 能力 | 授权的宿主 API |
|---|---|
| `state:read` | `ctx.state`（只读快照） |
| `tools` | `onToolResult` / `registerTool`（**仅**自己命名空间） |
| `prompt` | `onPrompt` / `getPromptContext` |
| `timer` | `onTick`（≥1000ms） |
| `gap:propose` | `proposeGap`（走核心去重，不能绕过） |
| `fs:organ` | `kv`（只能碰自己那个文件） |
| `net` / `llm` | 需要显式声明；未声明时宿主拒绝 |

**默认拒绝**（default-deny），不是默认允许。一个只写了 `kind:'memory'` 却没声明 `net` 的器官，试图发 HTTP 会立刻失败。

---

## 6. Evolution WebUI：它是"橱窗"，不是"监控"

### 6.1 为什么必须有 bridge

浏览器读不了 `~/.dsh/digital-life-core/state.json`（沙箱 + 同源策略）。所以三层：

```
state.json ──fs.watch──> bridge (Node, :8787) ──WS──> Vite (:5173) ──> React
```

bridge 是个 100 行的 Node 脚本：`fs.watch` + 200ms 去抖 + 环形缓冲 600 帧 + 一个 `/api/snapshot` 兜底（WS 断了还能轮询）。它**只读**，不提供任何写接口——避免 WebUI 变成第二个可以改状态的入口。

### 6.2 三块视图的技术选型

| 视图 | 选型 | 为什么 |
|---|---|---|
| 神经脉冲图 | 手写 Canvas 2D + 环形缓冲，`requestAnimationFrame` 直接画 | 10Hz × 3 条曲线 = 每秒 30 个点。用 React state 驱动重渲染会掉帧；用图表库则是为了三条线引入 200KB。Canvas 是唯一正确解。 |
| 器官生态树 | 纯 DOM 树（kind → organ → tools），零依赖 | 器官数量是几十量级，虚拟化都嫌早。 |
| 执念裂变图 | **d3-force 2D 力导向** + 3D 星空背景层 | 真正的 3D 粒子好看但标签不可读，而"张力"必须能被读数。用 2D 保证可读性，3D 只做氛围——展示橱窗需要的是"看起来是活的"，不是"难以操作"。 |

### 6.3 性能预算

- 脉冲图：单 canvas，热路径**不碰 React**（`useRef` 持缓冲，rAF 直接 draw）。
- 力导向：只在 `gaps` 的 id 集合哈希变化时重算布局；张力变化只改半径/颜色（CSS 变量），不重排。
- 遥测表：虚拟滚动留到节点 > 500 再做，先不做。

---

## 7. 落地切片（每片可独立验收、可回滚）

| 片 | 内容 | 验收标准 |
|---|---|---|
| **PR1** | ABI + `defineOrgan` + 单元测试（含 C1–C3 的反例测试） | `npm run typecheck:organs` 绿；三个"坏器官"用例被正确降级 |
| **PR2** ✅ | Organ Host 骨架：装载、能力授权、刺激翻译、反馈仲裁、遥测缓冲 | 现有 `digital-life-core` 行为零变化（回归测试全绿） |
| **PR3** ✅ | 记忆器官接入 + 核心去掉对 `memory.saveTools/searchTools` 的硬编码 | 记忆相关测试迁移到器官侧；核心不再出现工具名 |
| **PR4** | WebUI：bridge + 脉冲图 → 器官树 → 执念裂变图 | 3 秒内出首帧；10Hz 不掉帧（Performance 面板验证） |

**顺序不能换**：先有 ABI 才有宿主，先有宿主才有第一个器官，先有遥测才有 WebUI。任何一步提前都会导致返工。

---

## 8. 反模式清单（评审时逐条对）

1. ❌ 器官自己 `setState` —— 破坏 C1，边界全部失效。
2. ❌ 器官在 `getPromptContext()` 里做 IO 或调模型 —— 它在**每次**组装提示词时都会被调用，会把一轮对话拖成十秒。
3. ❌ 器官之间通过全局变量通信 —— 用 `ctx.emit()`，否则没法卸载。
4. ❌ 在 `feedback` 里做长耗时计算 —— 它在工具返回的临界路径上，超过 50ms 就影响体感。
5. ❌ 把"能力"做成器官（比如 `wake`）—— 意志是底座，不是器官。**能动的东西不能让第三方替换。**
6. ❌ WebUI 提供写接口 —— 观测面板一旦能写，就变成绕过所有安全设计的后门。

---

## 9. 本次交付物

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/life-organ.ts` | ABI 定义 + `defineOrgan` 助手 + 三条约束的运行时兜底 | ✅ 已通过 tsc |
| `src/organs/memory-organ.ts` | 包装真实 `dsh-memory-layer@0.10.2` 的第一个器官 | ✅ 已通过 tsc |
| `tsconfig.organs.json` | 器官代码的独立类型检查（不污染主构建） | ✅ |
| `web-ui/README.md` | 目录结构 + 启动指南 + 数据契约 | ✅ |

### PR2 已落地（本次）

| 文件 | 作用 | 验证 |
|---|---|---|
| `src/organ-host.ts` | Organ Host：拓扑装载 / 能力白名单 / 能量会计 / 反馈仲裁 / 提示词拼装 / 遥测 | `test:organs` 17 组断言全绿 |
| `test/organ-host.test.mjs` | 假 deps 下的行为测试（C1–C3、shadow/additive、截断、停摆、重名、环依赖） | ✅ |
| `web-ui/server/bridge.mjs` | 只读桥：fs.watch + 1s 轮询兜底 + WS 广播 + /api/snapshot | curl 与 WS 客户端实测通过 |
| `web-ui/src/components/PulseCanvas.tsx` | Canvas 2D 脉冲图，热路径不碰 React | `tsc` + `vite build` 通过 |
| `web-ui/src/components/OrganTree.tsx` | 器官生态树 + 详情抽屉 + 空态 | 同上 |

### PR3 已落地（本次）

| 文件 | 作用 | 验证 |
|---|---|---|
| `index.ts` 的 `organDeps` | 10 个 deps 的真实实现（readState / debitEnergy / applyAffect / proposeGap / registerTool / subscribeToolResult / callTool / schedule / organKV / log） | 真机 `器官=memory:loaded` |
| `index.ts` 的 `tools/post-execute` | 只剩一条搜索空结果规则 + 交给 `organHost.handleToolResult`；**零工具名** | 单测 + 真机 |
| `src/organs/memory-organ.ts` v2.0.0 | 检索重排 / 锚点 / 梦境写入全部落地；能力声明补齐 `timer`+`fs:organ` | 37 条断言 |
| `src/organs/memory-affinity.ts` | 从核心搬出的纯函数（切条 / 情绪打分 / 锚点键 / 改写） | 纯函数测试 |
| `src/organ-host.ts` | 新增 `handleToolResult()`：先派发再改写，按装载顺序先到先得 | 新增 3 组断言（共 20） |
| `organs/<name>.json` | 遥测落盘：WebUI 器官树的数据源（`organs/kv/` 存器官私有数据） | 桥实测读到 |

**ABI 因这次移植补了四个面**（都不是"设计遗漏"，而是移植时才暴露的真实需求）：
`rewriteToolResult()`（只改呈现不改副作用）、`OrganContext.callTool()`（器官要能写回）、
`OrganStimulus.arguments`（不带入参就不知道存了什么）、`proposeGap(organ, …)`（来源可追）。

**未做（PR4）**：执念力导向星图、WebUI 事件流面板、器官详情抽屉接 `recent` 事件。
