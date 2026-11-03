/**
 * 无损 JSON 净化层（Lossless-JSON sanitizer）
 * ============================================================================
 * DSH 在工具返回时会对 **value** 做一次"无损 JSON"快照（`snapshotJsonValue`），
 * 不通过就抛：
 *
 *   tool "xxx" returned invalid output: value is not lossless JSON
 *
 * 这一层把"什么算无损"钉死，并提供一个**永不失败**的复制器：
 * 任何值进去，出来的都是能安全穿过 JSON 往返的普通对象。
 *
 * 什么会被判成"有损"（逐条来自 @deepseek-ai/dsh-util-values 的 walkJsonValue）：
 *   1. undefined（对象里的键、数组里的项都算）
 *   2. 非有限数：NaN / Infinity / -Infinity
 *   3. **-0**（这条最阴：`Math.round(-0.4)` 就是 -0，JSON.stringify 会写成 `0`，往返后不相等）
 *   4. bigint
 *   5. 非普通对象：Date / Map / Set / Buffer / 类实例 / null 原型对象
 *   6. 稀疏数组、带额外自有键的数组
 *   7. 环引用
 *   8. function / symbol
 *
 * **字符串永远是"无损"的**——哪怕里面有 emoji 半个代理对、NUL、控制字符。
 * 所以"内容含特殊字符导致 JSON 序列化失败"这个说法在 DSH 这条链路上不成立；
 * 真正会炸的是上面那八类**值**。字符串仍然要洗（见 sanitizeText），
 * 但那是为了模型可读性与会话文件编码，不是为了过校验。
 */

/** 环引用替换成这个标记，而不是让整次调用失败。 */
const CIRCULAR = '[循环引用]'

/**
 * 把任意值深拷贝成无损 JSON。
 *
 * 约定（都选"能保住信息、且不撒谎"的一侧）：
 *   - undefined → **删掉这个键**（对象里），数组里 → null（保持长度与下标）
 *   - NaN / ±Infinity / -0 → null / 0
 *   - bigint → 十进制字符串（转 number 会悄悄丢精度）
 *   - Date → ISO 字符串；Map → 对象；Set → 数组
 *   - 函数 / symbol → 删掉（对象里）或 null（数组里）
 *   - 环引用 → `[循环引用]`
 *   - 类实例 → 只保留自有可枚举字段（丢掉原型方法，这是 JSON 的语义）
 */
export function toLosslessJson(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    const num = value as number
    if (!Number.isFinite(num)) return null
    // -0 必须归一：Object.is(-0, 0) 为 false，但 JSON 往返只能得到 0。
    return Object.is(num, -0) ? 0 : num
  }
  if (type === 'bigint') return (value as bigint).toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined

  const object = value as object
  if (seen.has(object)) return CIRCULAR
  seen.add(object)
  try {
    if (object instanceof Date) {
      const time = object.getTime()
      return Number.isFinite(time) ? object.toISOString() : null
    }
    if (object instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [key, item] of object) out[String(key)] = toLosslessJson(item, seen)
      return out
    }
    if (object instanceof Set) {
      return [...object].map((item) => toLosslessJson(item, seen))
    }
    if (Array.isArray(object)) {
      // 稀疏数组按"洞里补 null"处理：长度不变，下标不塌。
      const out: unknown[] = []
      for (let index = 0; index < object.length; index += 1) {
        const item = toLosslessJson(object[index], seen)
        out.push(item === undefined ? null : item)
      }
      return out
    }
    if (object instanceof ArrayBuffer || ArrayBuffer.isView(object)) {
      // TypedArray / Buffer：不当作 JSON 对象展开（否则会变成 {"0":255,...}），
      // 直接给一个可诊断的标记，长度留着方便排查。
      const size = object instanceof ArrayBuffer ? object.byteLength : (object as ArrayBufferView).byteLength
      return `[二进制 ${size} 字节]`
    }

    const out: Record<string, unknown> = {}
    for (const key of Object.keys(object)) {
      const item = toLosslessJson((object as Record<string, unknown>)[key], seen)
      // 无损 JSON 不允许 undefined：对象里直接删键（保留 null 才是"有值但没有"）。
      if (item !== undefined) out[key] = item
    }
    return out
  } finally {
    seen.delete(object)
  }
}

/**
 * 洗文本：把"能过 JSON 但会让下游难受"的字符处理掉。
 *
 * - 落单的代理对（截断 emoji 常见）→ U+FFFD：写入 UTF-8 文件时它会变成乱码，
 *   模型也会看到替换字符，不如自己先换成可见的问号。
 * - 除 \n \t \r 外的 C0 控制字符 → 去掉（终端/日志里会把一行撕成几段）。
 * - 过长的行内空白压缩（可选）。
 */
export function sanitizeText(input: string, maxLength?: number): string {
  if (typeof input !== 'string') return ''
  let text = input
    // 落单的高/低代理：前面不是高代理的高代理、后面不是低代理的低代理
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    // C0 控制字符（保留换行/制表/回车）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  if (typeof maxLength === 'number' && maxLength > 0 && text.length > maxLength) {
    text = truncateSafe(text, maxLength)
  }
  return text
}

/**
 * 按长度截断，且**不劈开代理对**。
 * `text.slice(0, 200)` 劈开 emoji 是真实事故来源：截出来的是半个字符。
 */
export function truncateSafe(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  let end = maxLength
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}
