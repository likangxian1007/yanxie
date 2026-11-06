/**
 * 可变插槽：编辑器扩展在创建时拿到插槽，React 组件在 effect 里往里放最新的回调。
 * （扩展只创建一次，回调却随渲染变化；用方法读写而不是直接改对象属性。）
 */
export class Slot<T> {
  private value: T | null = null;

  set(value: T | null) {
    this.value = value;
  }

  get(): T | null {
    return this.value;
  }
}
