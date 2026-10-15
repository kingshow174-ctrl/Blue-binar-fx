export const bus = {
  fns: new Set(),
  emit(m) {
    this.fns.forEach((f) => {
      try { f(m) } catch (e) { console.error(e) }
    })
  },
}
