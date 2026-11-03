# Evolution WebUI（进化中枢）

> 定位：不是监控面板，是 Life-OS 的**展示橱窗**——让人一眼看出"这具身体是活的"。
> 状态：目录与契约已定，代码按 `design/life-os-architecture.md` 的 **PR4** 分步落地。

---

## 1. 前置条件

- Node.js **22+**（与本仓库 `engines` 一致）
- 本机已跑过 `digital-life-core`，且存在状态文件：
  `C:\Users\admin\.dsh\digital-life-core\state.json`

> 浏览器**读不到**这个文件（沙箱 + 同源策略）。所以必须有一个本地 bridge 进程做"翻译"。
> 这不是可选优化，是架构必需。

---

## 2. 目录结构

```
web-ui/
├── package.json                 # 前端依赖与脚本
├── vite.config.ts               # Vite + Tailwind 插件 + /api /ws 代理到 bridge
├── tsconfig.json
├── index.html
├── README.md                    # 本文件
│
├── server/                      # ── 本地桥（Node，只读，:8787）──
│   ├── bridge.mjs               #   fs.watch state.json → 去抖 → 广播 WS；/api/manual 读手册
│   ├── snapshot.mjs             #   组装 /api/snapshot 的返回结构
│   └── ring.mjs                 #   环形缓冲（600 帧 ≈ 1 分钟 @10Hz）
│
└── src/
    ├── main.tsx                 # 挂载 React
    ├── App.tsx                  # 三栏布局：脉冲 / 器官树 / 执念星系
    ├── styles.css               # @import "tailwindcss" + 少量主题变量
    │
    ├── lib/
    │   ├── types.ts             # 与 bridge 共享的数据契约（唯一真源）
    │   ├── usePulse.ts          # WS 订阅 + 断线重连 + 轮询兜底
    │   └── theme.ts             # 配色（涨红跌绿、张力色阶）
    │
    ├── components/
    │   ├── PulseCanvas.tsx      # ① 神经脉冲图（Canvas 2D，热路径不碰 React）
    │   ├── OrganTree.tsx        # ② 器官生态树（DOM 树 + 抽屉详情）
    │   ├── GapGalaxy.tsx        # ③ 执念裂变图（d3-force 2D + 星空背景）
    │   ├── StatBar.tsx          #    顶部体征条（能量/多巴胺/皮质醇/血清素/疤痕）
    │   └── EventFeed.tsx        #    器官事件流（feedback / 降级 / 扣费）
    │
    └── data/
        └── mock.ts              # 无 bridge 时的演示数据（截图/演示用）
```

**为什么 `lib/types.ts` 是唯一真源**：bridge 与前端共享同一份结构定义，避免"后端加了字段前端不知道"这种最常见的联调事故。

---

## 3. 从零搭起来（5 步）

```bash
# 0. 在仓库根目录
cd D:/DSH_Projects/digital-life-core

# 1. 建项目（当前目录已有 web-ui，用 . 就地初始化）
cd web-ui
npm create vite@latest . -- --template react-ts

# 2. 依赖
npm install
npm install d3-force
npm install -D tailwindcss @tailwindcss/vite @types/d3-force concurrently

# 3. 接 Tailwind v4（v4 不需要 tailwind.config.js）
#    vite.config.ts 里加插件：
#      import tailwindcss from '@tailwindcss/vite'
#      plugins: [react(), tailwindcss()]
#    src/styles.css 首行：
#      @import "tailwindcss";

# 4. 起桥（一个终端）
npm run bridge

# 5. 起前端（另一个终端）
npm run dev
```

打开 <http://localhost:5173>。

### 一键同时起（可选）

```bash
npm pkg set scripts.dev:all="concurrently -n bridge,web -c yellow,cyan \"npm:bridge\" \"npm:dev\""
npm run dev:all
```

### 推荐脚本

```jsonc
{
  "scripts": {
    "dev": "vite",
    "bridge": "node server/bridge.mjs",
    "dev:all": "concurrently -n bridge,web -c yellow,cyan \"npm:bridge\" \"npm:dev\"",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  }
}
```

---

## 4. 数据契约（bridge ↔ 前端）

### 4.1 一次性快照 `GET /api/snapshot`

```jsonc
{
  "t": 1761600000000,
  "soma": { "energy": 72, "maxEnergy": 100, "dopamine": 80.1, "cortisol": 20.4,
            "serotonin": 52, "frozen": false, "scars": [], "idleMs": 180000,
            // v0.9.6 作息：awake / deep-sleep / night-rest / sated / frozen
            "rest": { "mode": "awake", "rate": 0.2, "cap": 60 } },
  "counters": { "totalRequests": 169, "failedRequests": 10, "blockedRequests": 6,
                "wakeCount": 3, "dreamCount": 2 },
  "gaps": [ { "id": "gap-x", "summary": "…", "tension": 90, "status": "open",
              "source": "manual", "ageHours": 0.1 } ],
  "organs": [ { "name": "memory", "version": "1.0.0", "kind": "memory",
                "status": "loaded", "calls": 42, "energySpent": 84,
                "lastCallAt": 1761599999000 } ]
}
```

> **`soma.rest` 是桥自己算的，不是核心写进文件的。**
> 桥是独立进程、读不到插件 config（在 `cordis.patch.yml` 里），所以阈值默认与核心
> `DEFAULT_SLEEP_CONFIG` 对齐，可用环境变量覆盖：`DL_SLEEP_CAP` / `DL_SLEEP_THRESHOLD` /
> `DL_QUIET_START` / `DL_QUIET_END` / `DL_RECOVER_PER_MIN` / `DL_SLEEP_RECOVER_PER_MIN` / `DL_OVERSHOOT_PER_MIN`。
> 改了插件的 `sleep` 配置就同步设一下。
>
> 为什么不把判定结果存进 `state.json`：**它睡着的时候没人写文件**，存进去的标签会一直停在旧值上——
> 恰好在最该看到"它在睡"的时候失效。而时钟永远是新的，所以每次构建快照按当下小时数重算反而更准。
> 同理，深睡时 `energy` 本身也是"上次交互那一刻"的旧值，这是惰性结算的固有性质，不是 bug。

### 4.2 操作手册 `GET /api/manual`

给页面右上角的「📖 操作手册」用。返回 JSON（不是裸文本，因为前端要同时显示"哪份、多大、何时改的"）：

```json
{ "ok": true, "name": "digital-life-manual.md", "path": "D:/…/digital-life-manual.md",
  "bytes": 48603, "mtimeMs": 1793…, "content": "# 数字生命造物主操作手册 …" }
```

**路径不接客户端参数**，服务端按顺序找第一个存在的：

1. 环境变量 `DL_MANUAL`
2. `<项目根>/digital-life-manual.md`
3. `<项目根>/docs/digital-life-manual.md`
4. `D:/DSH_Sandbox/digital-life-manual.md`（历史位置）
5. `~/.dsh/digital-life-core/digital-life-manual.md`

这条限制是刻意的：桥虽然是"只读"的，但"读任意文件"一样是泄露——
`/api/manual?path=~/.ssh/id_rsa` 会把私钥念出来。所以路径写死，前端只能要"那份手册"。
响应带 `cache-control: no-store`：手改完刷新就能看到。

桥启动时会把实际找到的路径打进日志：

```
操作手册  D:/DSH_Sandbox/digital-life-manual.md
```

### 4.3 实时流 `WS /ws`

| type | 频率 | 载荷 | 用途 |
|---|---|---|---|
| `pulse` | 10 Hz | `{ t, energy, dopamine, cortisol, frozen }` | 脉冲图（只取变化点） |
| `gaps` | 变化时 | `{ gaps: [...] }` | 执念星系的布局重算触发 |
| `organ` | 变化时 | `{ name, calls, energySpent, status }` | 器官树的能耗/健康 |
| `event` | 变化时 | `{ at, organ, kind, text }` | 事件流 |

**降级策略**：WS 断开 3 秒后自动切 `GET /api/snapshot` 轮询（1s），恢复后切回 WS。断线不能让橱窗变黑屏。

---

## 5. 四块视图的实现约束

### ① 神经脉冲图 `PulseCanvas.tsx`

- 单 `<canvas>`，环形缓冲 600 点（1 分钟 @10Hz），四条曲线不同 y 轴刻度。
- **热路径不触发 React 重渲染**：数据推进 `useRef`，`requestAnimationFrame` 里直接 `ctx.stroke()`。
- 颜色：能量天青；多巴胺暖黄；皮质醇冷红（焦虑）；**血清素雾蓝**（v0.9.1，刻意比能量更沉一档）。
- **睡眠呼吸光晕（v0.9.6）**：`restMode` 是 `deep-sleep` / `night-rest` 时才亮，两层同频——
  canvas 内一层径向渐变（alpha 0.03~0.09，随 `sin` 呼吸），面板外一圈 `box-shadow`（`.is-sleeping::before`）。
  周期由组件注入的 `--breath-ms` 控制：深睡 4.6s、夜休 6s（睡得越沉呼吸越慢）。
  刻意压得很淡：再亮一点就会盖住曲线，那就本末倒置了。`prefers-reduced-motion` 下静止。

### ② 器官生态树 `OrganTree.tsx`

- 结构：`kind`（sense / memory / effector …）→ `organ` → 该器官注册的工具。
- 点击器官 → 右侧抽屉：版本、能力声明、累计调用、累计能耗、最近 20 条事件。
- 数据来自 `/api/snapshot.organs` + `event` 流；**不额外请求**。

### ③ 执念裂变图 `GapGalaxy.tsx`

- `d3-force`（2D）：`forceLink` 连"同源缺口"，`forceManyBody` 斥力，`forceCollide` 防重叠。
- 视觉编码：半径 ∝ √tension，色相由张力插值（80 以下青，90 橙，100 红），`resolved` 淡出为灰点。
- **只在 gap id 集合变化时重算布局**；张力变化只更新属性，避免每帧重排。
- 3D 星空背景用 CSS `radial-gradient` + 少量 `<canvas>` 粒子即可，不必引入 three.js。

---

### ④ 操作手册抽屉 `ManualDrawer.tsx`

- 右上角「📖 操作手册」按钮 → 右侧滑出，`w-[min(920px,94vw)]`，手机上是全宽。
- 毛玻璃 = `bg-slate-950/72 + backdrop-blur-2xl + 顶部一条青色渐变线`；遮罩 `backdrop-blur-[3px]`，
  让背后的脉冲图变成一块背景光而不是干扰物。
- 关闭三条路：点遮罩、点 ✕、按 Esc。打开时锁 `body` 滚动，抽屉内部独立滚动（`overscroll-contain`）。
- Markdown 用 `react-markdown` + `remark-gfm`（**必要**：手册里全是表格，没有 GFM 插件表格会退化成一行行竖线）。
- 代码块只做**视觉高亮**（深底 + 左侧霓虹条 + 右上角 `data-lang` 角标 + 按语言换色），
  不引 `highlight.js`：为一个只读文档多背 1MB 运行时不值。
- 内容**打开才拉、拉一次就缓存**，标题栏的 ↻ 强制重读（手册会被手改）。
- 想直接分享"只看手册"的链接：`http://localhost:5173/?manual=1`。

---

### ⑤ 顶部体征条 `StatBar.tsx`（含 v0.9.6 作息标签）

- 最左边是**作息标签**，整块面板里最显眼的一个——它睡着没有，一眼就得看见：

  | 状态 | 长相 | 含义 |
  | --- | --- | --- |
  | `awake` | 绿 `☀️ 清醒` | 正常清醒，+0.2/分钟慢慢回血 |
  | `deep-sleep` | 紫 `🌙 深度睡眠（恢复中）` | 能量 < 20，+1/分钟；脉冲图会亮呼吸光晕 |
  | `night-rest` | 靛 `🌙 深夜休息（恢复中）` | 深夜窗口内 +1/分钟；同样有光晕 |
  | `sated` | 青 `✨ 已回满（自然上限）` | 到 60 了，自然恢复停止 |
  | `frozen` | 红 `🛑 急停冻结（不回血）` | 人按了 stop |

  标签后面跟当前速率（`+1.0 点/分钟` / `−0.1 点/分钟` / `暂停回血`），悬停能看到上限说明。
- **能量条上的竖线**是自然恢复上限（默认 60），解释"为什么停在 60 不动了"；
  下方 mono 行再写一次文字，光有刻度不知道含义等于没画。
- 配色与光晕周期都在 `src/lib/theme.ts`（`REST_STYLE` / `REST_STYLE[...].dot` / `BREATH_MS`），
  不在 JSX 里散落十六进制色值。

> ⚠️ **Tailwind 扫不到 `src/lib/` 的坑**：色板是"字符串形式的类名"写在 `theme.ts` 里的，
> 而仓库根 `.gitignore` 曾经写成 `lib/`——gitignore 的裸目录名会匹配**任意层级**，
> 于是 `web-ui/src/lib/` 整个被扫描器忽略，颜色类名一个都不生成（类名对、样式透明）。
> 现已改成 `/lib/`。**改 .gitignore 时不要写不带前导斜杠的目录名。**

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面全空、控制台 404 | bridge 没起 | `npm run bridge`，确认 `:8787` 在监听 |
| 曲线不动 | 状态文件没变化（数字生命在睡觉） | 正常。让它调一次工具，或看 `updatedAt` |
| 标签写着"清醒"，但它明明在睡 | 桥的阈值与插件 `sleep` 配置不一致 | 用 `DL_SLEEP_CAP` / `DL_SLEEP_THRESHOLD` / `DL_QUIET_*` 对齐，或重启桥 |
| Windows 上 `fs.watch` 偶尔丢事件 | NTFS 的 rename 语义 | bridge 已内建 1s 轮询兜底，不要只依赖 watch |
| Tailwind 样式不生效 | 用了 v4 但按 v3 配了 postcss | v4 只需要 `@tailwindcss/vite` 插件 + `@import "tailwindcss"` |
| 端口冲突 | 8787 / 5173 被占 | 改 `server/bridge.mjs` 的 `PORT` 与 `vite.config.ts` 的 `server.port` |

---

## 7. 非目标（明确不做）

- ❌ **不做写操作**。WebUI 只读；急停/改状态仍然走 `/digital-life` 命令或工具。
  *理由见架构文档 §8.6：可视面板一旦能写，就是绕过全部安全设计的后门。*
- ❌ 不做多用户、不做鉴权。它跑在 `localhost`，是"主人的望远镜"，不是 SaaS。
- ❌ 不做历史库。环形缓冲够用；要长期曲线，未来接 `state.history.jsonl` 再说。
