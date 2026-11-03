/** 定长环形缓冲：常数内存、O(1) 写入。脉冲图的数据源。 */
export class Ring {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0)
    this.items = []
  }

  push(item) {
    this.items.push(item)
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity)
    }
  }

  toArray() {
    return this.items.slice()
  }

  get size() {
    return this.items.length
  }
}
