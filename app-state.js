// app.js owns mutations; feature modules receive a live read-only view or a
// detached snapshot. No library-wide copy is needed for an ordinary state read.
window.OwnTone.createAppState = initial => {
  const mutable = structuredClone(initial);
  const views = new WeakMap();
  const deny = () => {
    throw new TypeError('Application state is read-only; use an app action');
  };
  function readOnly(value) {
    if (!value || typeof value !== 'object') return value;
    if (!views.has(value)) {
      views.set(
        value,
        new Proxy(value, {
          get: (target, key, receiver) => readOnly(Reflect.get(target, key, receiver)),
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (descriptor && 'value' in descriptor) descriptor.value = readOnly(descriptor.value);
            return descriptor;
          },
          set: deny,
          deleteProperty: deny,
          defineProperty: deny,
          setPrototypeOf: deny,
          preventExtensions: deny,
        })
      );
    }
    return views.get(value);
  }
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  return {
    mutable,
    readOnly: readOnly(mutable),
    snapshot(keys = Object.keys(mutable)) {
      const selected = Object.fromEntries(keys.map(key => [key, mutable[key]]));
      return freeze(structuredClone(selected));
    },
  };
};
