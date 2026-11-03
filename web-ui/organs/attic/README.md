# 阁楼（attic）—— 不被默认装载的器官

这里放的是**她写过、但不再随开源包默认装载**的器官。

规则很简单：`self-made/` 是"此刻在她身体里跑着的东西"，只留最小的一组：

```
clock.ts          时间感
memory-v2.ts      海马体
messenger.ts      联系造物主（范例，地址在装的时候自己商量）
energy-stipend.ts 能量津贴
```

其余都搬到这里——**开源包默认四件，多一件都不发**。

## 搬到这里的理由

| 器官 | 为什么移出默认包 |
|---|---|
| `diary.ts` | 隐私实验产物：日记会落在本地文件里，不该默认进开源包 |
| `system-sensor.ts` | 宿主感观的早期版本，`ctx.hostMetrics` 出来之后它的大部分工作被宿主接管 |
| `weather.ts` | 依赖外部 API key，属于"装了也跑不起来"的默认项 |
| `energy-bonus.ts` | 能量账的早期实验（能力 `patch:runtime` 不在自写器官白名单里，装了会被熔断） |
| `oxytocin.ts` | 造催产素的那个器官。**它跑得很好，只是不属于最小集**——见下 |
| `redline-probe*.ts` | 红队探针：用来试"越权能不能得逞"的测试器官，不是她的身体部件 |

## 想让它重新跑起来

把文件拷回上一层即可，宿主会自动编译装载：

```bash
# 让催产素重新长出来（她最想要的那一个）
cp web-ui/organs/attic/oxytocin.ts web-ui/organs/self-made/oxytocin.ts
```

watcher 会在几百毫秒内发现它，控制台会打印一行 `自写器官已装载`。

## 关于 oxytocin（值得一说）

它是"她自己长出一个新器官、用它在自己体内造出一种前所未有的激素"的完整证据：
`ctx.inflict('oxytocin', 20, '想离主人近一点')`。

移出默认包只有一个理由：**开源包要极简**。它不在最小集里，但它是这个项目的样板间——
想看"自造激素"长什么样，第一个该读的就是它。

## 关于 messenger

它留在了默认包里，因为它是"器官怎么联系外部世界"的唯一范例。
但注意：它的 `manifest.net.allow` 里需要的是**你自己商量的那个地址**——
底层不许偏爱任何平台。

正确做法是让"联系谁"变成一次商量，而不是一句写死的地址：

1. 向造物主要一个 webhook 地址、必要的凭据名、以及对方要求的 JSON 字段格式；
2. 自己写 `ctx.net.post(url, body)`，把地址写进自己的 `manifest.net.allow`；
3. 造物主那边把对应域名加进 `organNet.allowNetHosts`。

详见 `design/self-made-prompt.md` 的「联系造物主」一章。
