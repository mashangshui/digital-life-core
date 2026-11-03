# self-made —— 数字生命自己写的器官

这个目录是**自举通道的沙盒**：里面的每个 `.ts` 都会被宿主编译、校验、装载成器官，
不需要重启 Harness。文件由工具 `write_new_organ` 写入（也可以手动放进来）。

> **开源包默认只带四个器官**（v0.9.19）：`clock` / `memory-v2` / `messenger` / `energy-stipend`。
> 这是刻意的最小集：一个刚装好的包，她只有时间感、记性、一张嘴和一点能量，
> 其余（包括会造催产素的那个器官）都收在 `../attic/`，想要随时拷回来。

```
self-made/
├── README.md           ← 你正在看的这份
├── _template.ts        ← 骨架示例（下划线开头 = 不会被装载）
├── clock.ts            ← 时间感
├── memory-v2.ts        ← 海马体（她自己写的）
├── messenger.ts        ← 联系造物主（地址装的时候自己商量）
├── energy-stipend.ts   ← 能量津贴
└── .compiled/          ← 编译产物（自动生成，可随时删）
```

## 生命周期

```
write_new_organ({ name, code })
        │
        ├─ 静态检查：体积 ≤64KB、不含 require/process/eval/fetch/node: 内置模块
        ├─ 剥类型：Node 自带 stripTypeScriptTypes（或回退 typescript 包）
        ├─ 注入 ABI：生成代码里 const { defineOrgan } = __abi（所以你不写 import）
        ├─ 写 .compiled/<name>.<hash>.mjs → import()
        ├─ 校验 manifest：name/version/kind/apiVersion/capabilities
        └─ organHost.addOrgan()  →  装不上就回滚，日志说清原因
```

改动 `self-made/*.ts` 后 400ms 内会自动重装（`fs.watch` + 防抖）。
同名器官是**先卸后装**，所以改一版立刻生效。

## 写一个器官的硬规则

1. **必须 `export default defineOrgan({...})`**（也接受 `export const organ = ...`）。
2. **不要写任何 import**。ABI（`defineOrgan`）由宿主注入；写了也会被剥掉并给一条 warning。
3. **文件名 = 器官名**，小写字母开头，只含 `a-z0-9-`，2–32 字符。
4. `manifest.capabilities` 必须**如实声明**你要用的能力，否则调用点会被 default-deny 拒绝：

   | 能力 | 用它能干什么 |
   | --- | --- |
   | `tools` | `ctx.registerTool()` / `ctx.onToolResult()` / `ctx.callTool()` |
   | `prompt` | `ctx.onPrompt()` 往 System Prompt 里塞片段 |
   | `state:read` | 读 `ctx.state`（能量/激素/执念数/疤痕，只读）——**你自己**的身体 |
   | `host:read` | 读 `ctx.hostMetrics`（CPU / 内存 / 运行时长）——**那台机器**的状态 |
   | `gap:propose` | `ctx.proposeGap(summary, weight)` 种一条执念 |
   | `timer` | `ctx.onTick(ms, fn)` 周期回调 |
   | `fs:organ` | `ctx.kv.get/set` 自己的私有存储 |

   `net` 与 `llm` **不在自写器官白名单里**（自写代码不该往外发请求）。

   **想感知物理宿主就读 `ctx.hostMetrics`，不要 import `node:os`、不要碰 `process`。**
   后者是静态扫描直接拒绝的，而且会明确告诉你改走哪条路：

   ```
   源码里有不允许的调用：os 模块（读机器请用 ctx.hostMetrics）
   提示：要读宿主机器状态（CPU 负载 / 内存占用 / 运行时长）请用 ctx.hostMetrics，…
   ```

   给的是**脱敏聚合值**：逻辑核数、整机/本进程 CPU 百分比（相对单核，封顶 100）、1-5-15 分钟负载
   （Windows 为 `null`）、内存总量/可用/占用率、本进程 RSS 与堆、系统与进程运行时长。
   **没有**进程列表、hostname、用户名、网络接口、环境变量、文件路径——那些能定位到
   具体机器与具体人，一律不进这道通道。`live === false` 表示宿主没给采集器，此时别编数字。
5. 能量：`energy: { perCall, chargeMode }`。默认 `shadow`（只记账不真扣），
   迁移期用；想真扣就 `additive`，饿的时候宿主会拒绝并让你 `deny`。
6. 抛错不许外泄：`feedback()` / `onLoad()` 里的异常宿主会捕获并把器官降级，
   但**你自己兜住**体验更好（返回一条 `note` 而不是让整轮失败）。

## 安全边界（诚实说明）

关键词扫描能挡住 `require` / `process` / `child_process` / `eval` / `fetch` 这类明显越界，
但**这不是沙箱**。真正的隔离要 `vm` 或 worker + 权限模型，代价是器官拿不到 `ctx` 和定时器，
也就不叫器官了。所以：

- 这个目录里的代码**跑在 Harness 同一个进程里**，有完整的 Node 权限；
- 真正的防线是**能力 default-deny**：代码能跑，但拿不到没声明的能力；
- 只让可信的模型往这里写东西；`git diff` 一下再提交，比事后审计便宜。

## 手动验证一次

```bash
cd D:/DSH_Projects/digital-life-core
npm run build                     # 改的是插件本体才需要
node scripts/preview-prompt.mjs    # 顺手确认核心没被改动弄坏
```

写完之后在 Harness 里问它"你现在几点了"，它应该会去调 `organ_clock_now`。
