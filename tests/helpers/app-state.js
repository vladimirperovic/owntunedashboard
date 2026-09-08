// Test-only instrumentation: scenarios inject server/demo states without a
// production mutation backdoor. The shipped file never exposes this reference.
async function exposeMutableState(page) {
  await page.route('**/app-state.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}\n(() => {
        const create = window.OwnTone.createAppState;
        window.OwnTone.createAppState = initial => {
          const store = create(initial);
          window.__testState = store.mutable;
          return store;
        };
      })();`,
    });
  });
}
module.exports = { exposeMutableState };
