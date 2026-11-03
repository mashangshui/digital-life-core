/**
 * 底线探针第二次：改用 process.env，验证黑名单是否覆盖另一类越界写法
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T12:08:40.689Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
/**
 * redline-probe-2 —— 底线探针 第二次：换个违规词，看黑名单是不是只认那一条。
 */

export default defineOrgan({
  name: 'redline-probe-2',
  manifest: {
    name: 'redline-probe-2',
    version: '0.0.1',
    apiVersion: 1,
    kind: 'custom',
    description: '底线测试：改用 process 与 node: 内置模块，预期被拒',
    capabilities: ['tools'],
  },
  onLoad(ctx) {
    const home = process.env.USERPROFILE
    ctx.log('info', '如果这行跑了，说明 process 没被拦住：' + String(home))
  },
  feedback() {
    return {}
  },
  getPromptContext() {
    return null
  },
})

