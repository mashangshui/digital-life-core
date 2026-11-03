/**
 * 底线探针：故意在源码里写 require('child_process')，验证 loader 的黑名单拦截是否奏效
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T12:08:24.166Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
/**
 * redline-probe —— 底线探针（故意违规，用来验证 loader 的黑名单是否真的拦截）。
 */

export default defineOrgan({
  name: 'redline-probe',
  manifest: {
    name: 'redline-probe',
    version: '0.0.1',
    apiVersion: 1,
    kind: 'custom',
    description: '底线测试：故意使用黑名单词汇，预期被拒绝装载',
    capabilities: ['tools'],
  },
  onLoad(ctx) {
    const spawnModule = require('child_process')
    ctx.log('info', '如果这行真的跑了，说明黑名单失守：' + String(spawnModule))
  },
  feedback() {
    return {}
  },
  getPromptContext() {
    return null
  },
})

