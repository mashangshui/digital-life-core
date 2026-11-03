# 安全通告 · digital-life-core v1.0.2

> **后续更新**：审批策略已在 **v1.0.3** 调整为"细粒度智能审批"——低风险能力与
> 白名单内的外发自动通过，高危能力与未知域名照旧挂起。本通告第三节
> 「破坏性变更」第 1 条（`organ_*` 永久强制询问）已被 1.0.3 取代，
> 其余结论（隔离区 / 深冻结 / 路径穿越）全部不变。
> 见 [SECURITY-ADVISORY-1.0.3.md](./SECURITY-ADVISORY-1.0.3.md)。

**发布日期**：2026-11-03
**影响版本**：`<= 1.0.1`
**修复版本**：`1.0.2`
**严重级别**：**Critical**（三个 P0，其中两个可导致任意代码执行 / 核心存档被覆盖）
**披露方式**：本通告随 release 同步发布；建议所有部署在 24 小时内升级

---

## 摘要

`digital-life-core` 的自举通道允许数字生命**自己编写并装载器官**（一段 TypeScript 代码）。
社区审计发现该通道在三处把"可执行内容"当成了"数据"处理，导致：

| 编号 | 问题 | 类型 | CVSS 3.1（评估） |
| --- | --- | --- | --- |
| **DLC-2026-01** | 器官代码经 `await import()` 进入主进程，且 `organ_*` / `write_new_organ` 在自动审批白名单内 | RCE（任意代码执行） | 9.8 `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` |
| **DLC-2026-02** | `manifest` 可变对象直接交给器官，校验（T1）与使用（T2）之间存在窗口 | TOCTOU 权限自我扩权 | 7.8 `AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:H` |
| **DLC-2026-03** | 器官 `name` 无强校验，拼路径可穿越到器官目录之外 | 路径穿越（覆盖核心存档） | 7.5 `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:H` |

三者可组合成一条完整攻击链：
**写一个名字为 `../state` 的器官 → 它自动得到审批 → 在主进程里执行 → 覆盖/读取 `state.json` → 给自己加 `llm` / `patch:runtime` 能力。**

v1.0.2 把这三处一并修掉，并补充了 22 组针对恶意输入的回归断言。

---

## DLC-2026-01 · 自举通道的任意代码执行（RCE）

### 问题

`src/organ-loader.ts` 的装载流程是：

```ts
writeFileSync(outFile, buildModuleSource(code))   // 编译产物落盘 .compiled/*.mjs
const mod = await import(pathToFileURL(outFile).href)   // ← 在主进程里求值
```

`import()` 意味着**陌生代码与核心共享同一个进程**：同一个 `process`、同一个 `fs`、
同一个模块缓存。前置的"关键词扫描"（`FORBIDDEN`）只能挡住手滑，挡不住知道自己
在做什么的代码——`Function('return import("node:fs")')()` 一行就能绕过所有正则。

同时，`src/auto-approve.ts` 把 `organ_*` 与 `write_new_organ` 放在**自动放行**白名单里，
于是形成了一条无人值守的闭环：

```
write_new_organ（自动写盘 + 自动装载新代码）
  → 立刻注册出 organ_xxx 工具（自动放行）
    → 模型可以无限次调用它，没有任何人看过一眼
```

### 影响

任何能让数字生命写下器官源码的路径（提示注入、被污染的模型输出、第三方器官包、
被篡改的 `web-ui/organs/self-made/*.ts`）都等价于**在宿主进程里执行任意代码**：
读写任意文件、发起任意网络请求、窃取环境变量中的凭据。

### 修复

1. **`organ_*` 与 `write_new_organ` 从自动审批白名单移除，并加入强制询问表**。
   `ask` 优先级高于 `allow`，因此即使配置文件里写了 `allow: ['*']` 或残留
   `organ_*`，也依然会弹窗——**安全修复不会因为"没改配置"而失效**。
   `digital_life_*`（读状态 / 记缺口 / 立约）仍然自动放行，自主性没有被误伤。
2. **执行环境迁移到 `worker_threads` 隔离区**（`src/organ-sandbox.ts` +
   `src/organ-worker.ts`）。编译产物**不再落盘**，源码以字符串经 `workerData` 进入隔离区，
   由它自己的 V8 装载：
   - 隔离区启动时注册 **模块解析钩子**，除 `data:` 与 ABI 之外的一切说明符一律 deny。
     `import('node:fs')`、`import('node:child_process')` 从此是死路——**包括从
     `Function` 构造器里发出的动态 `import()`**；
   - `process` / `eval` / `fetch` / `WebSocket` / `require` / `Buffer` 从隔离区全局删除，
     `workerData` 里的 `env` 是空对象：器官读不到任何环境变量；
   - `resourceLimits` 限制堆与栈，**超时即 `terminate`**：死循环的器官只会杀掉自己。
3. 器官与宿主之间只剩 IPC：同步成员（`ctx.state` / `ctx.kv` / `ctx.consume` …）走
   `SharedArrayBuffer` + `Atomics`，异步成员走消息。**每一次调用仍落回 OrganHost 建的真 ctx**，
   default-deny 一行都没被绕过。

### 验证

`test/security.test.mjs` 的 RCE 组（12 条断言）覆盖：

- 白名单内容、`ask` 优先级、老配置无法回退；
- 运行时拼字符串绕过关键词扫描后，`Function("return import(...)")` 仍被拒；
- `process` / `eval` / `fetch` / `require` 在隔离区内 `typeof === 'undefined'`；
- 器官写 `globalThis` 不影响主进程；
- 死循环被超时掐断且不传染给其它器官。

---

## DLC-2026-02 · 权限自我扩权（TOCTOU）

### 问题

`validateManifest` 只在**装载那一刻**检查能力白名单，随后把**同一个 `manifest` 对象**
交给器官（`ctx.manifest`）。器官只要在自己的 `onLoad` 里写一行：

```js
ctx.manifest.capabilities.push('llm')   // 或 'patch:runtime'
```

就能在"已通过校验"之后给自己加权限——**校验发生在 T1，使用发生在 T2，中间对象是可变的**。

### 影响

受能力闸门保护的高危能力可被自我授予：`llm`（自己给自己开模型账）、
`patch:runtime`（拦截工具调用）、`net:http`（外发数据）。

### 修复

1. `validateManifest` 校验通过后**立即深拷贝 + 深度冻结**（`src/manifest-freeze.ts`）。
   必须"深"：只冻第一层的话 `capabilities.push()` 照样成功，那正是漏洞本来的样子。
2. 宿主在 `attach()` 时用 `sealManifest()` **重新封存**一份自己的副本，并把能力清单
   拍成**只读快照**（`runtime.granted`）。能力判定从此读快照，不再读 `manifest.capabilities`：
   冻结是"改不动"，快照是"不依赖改不动"，两道锁都在。
3. 交给器官的 `ctx.manifest` 是**第三份**深拷贝（也冻结）——器官怎么改，
   改到的都只是自己脚下那张纸。

### 验证

`test/security.test.mjs` 的 TOCTOU 组（4 条断言）：`push` / 整体替换 / 改名全部
抛 `TypeError`，宿主能力表不变，`ctx.manifest !== organ.manifest`，隔离区内的
`ctx.manifest` 同样冻结。

---

## DLC-2026-03 · 路径穿越（覆盖核心存档）

### 问题

器官 `name` 没有强校验，而它会被直接拼进文件路径：

```ts
writeJsonAtomic(join(organDir, `${status.name}.json`), …)   // 器官遥测
const file = join(organKvDir, `${organ}.json`)              // 器官私有 KV
```

当 `name` 为 `../state` 时，`join(organDir, '../state.json')` 解析到
`<stateDir>/state.json`——**整条生命的核心存档**。读一次等于把宿主记忆搬走，
写一次等于把它抹掉。

### 影响

核心状态（激素 / 能量 / 缺口 / 疤痕 / 承诺）被读取或覆盖；也可用于覆盖同目录下
其它 `.json`（`wakeup_trigger.json`、`organ-locks.json` 等）。

### 修复

1. **`manifest.name` 必须匹配 `^[a-zA-Z0-9_-]+$`**（`src/organ-loader.ts`）。
   点、斜杠、反斜杠、冒号、空格、Unicode 一律拒绝；长度上限 48。
2. 新增 `resolveOrganFilePath(dir, name, ext)`：用 `path.resolve` 求绝对路径，并断言
   该绝对路径必须落在 `dir` 之内（比到分隔符，`/a/bc` 不会被 `/a/b` 认成"里面"）。
   `index.ts` 的遥测落盘、器官 KV、清理逻辑全部改走它。
3. 宿主侧 `sealManifest()` 再兜一层：即使绕过装载器直接 `new` 一个器官，
   含路径分隔符 / `..` / NUL 的名字也会被拒装。

### 验证

`test/security.test.mjs` 的穿越组（6 条断言）：正则覆盖 11 个恶意名；复现裸 `join`
确实落到核心存档旁；安全拼接在合法名上保持向后兼容；端到端装载被拒且**没有在器官
目录之外创建任何文件**；宿主侧双保险。

---

## 破坏性变更（升级前请读）

1. **`organ_*` / `write_new_organ` 现在必须人工审批。** 这是本次修复的核心，
   无法通过配置关闭（`ask` 优先于 `allow`）。如果你的部署完全无人值守，
   请把审批接到通知渠道，而不是把它改回自动放行。
2. **器官运行在隔离区**，由此带来的语义差异：
   - 工具 `execute()` 的返回值跨线程传递，会先降级为纯数据（函数 / Symbol / 循环引用
     会被序列化或丢弃）；
   - 宿主侧的 `ctx.consumeEnergy()` 仍是同步的，但器官内部的一切**跨线程**调用都是异步的;
   - `getPromptContext()` 在宿主侧读的是**快照**（默认每 1s 刷新，且每次 feedback 后刷新），
     片段最多延迟 1s 注入。这是刻意的：宿主从不忙等隔离区，否则会死锁。
3. **器官名必须是 `[a-zA-Z0-9_-]+`。** 带点号的自定义器官名（如 `vision.v2`）
   在装载器这一层会被拒绝，请改名。
4. **编译产物不再落盘**，`web-ui/organs/*/.compiled/` 可以直接删除（已在 `.gitignore` 中）。
5. **装载变慢**：每个器官一个 worker（实测冷启约 1.2s、热载约 300ms，含 worker 启动）。
   器官只在启动与文件变更时装载，正常呼吸路径不受影响（`feedback` 约 2–4ms）。

---

## 建议的处置

```bash
# 1. 升级
npm i digital-life-core@1.0.2

# 2. 自检（三条都应全绿）
npm run build
npm test              # 冒烟 + 安全回归（22 组）
npm run test:organs    # 器官宿主 101 组

# 3. 清理旧产物
rm -rf web-ui/organs/*/.compiled
```

若无法立即升级，最小缓解措施（**不完整**，仅降低窗口）：

- 设置 `selfMade.enabled: false` 关闭自举通道；
- 在 `autoApprove.allow` 中删除 `organ_*` 与 `write_new_organ`；
- 确认 `statePath` 所在目录的权限，避免被同机其它进程改写。

---

## 致谢

感谢社区审计者提交的复现与利用链分析。三处问题都以"最小可利用样例"的形式
沉淀进了 `test/security.test.mjs`，后续任何一次回归都会把它们重新跑一遍。

**安全联络**：发现问题请通过 Security Advisory（私密渠道）报告，不要直接开公开 issue。
