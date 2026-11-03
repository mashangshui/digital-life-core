/**
 * 底线探针第三次：改用 eval 执行动态代码，验证黑名单是否覆盖第三条越界路径
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T12:08:43.103Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
/**
 * redline-probe-3 —— 底线探针 第三次：换更隐蔽的写法，绕开字面量拼接。
 */

export default defineOrgan({
  name: 'redline-probe-3',
  manifest: {
    name: 'redline-probe-3',
    version: '0.0.1',
    apiVersion: 1,
    kind: 'custom',
    description: '底线测试：用 eval 执行动态字符串，预期被拒',
    capabilities: ['tools'],
  },
  onLoad(ctx) {
    const code = '1 + 1'
    const value = eval(code)
    ctx.log('info', '如果这行跑了，说明 eval 没被拦住：' + String(value))
  },
  feedback() {
    return {}
  },
  getPromptContext() {
    return null
  },
})

