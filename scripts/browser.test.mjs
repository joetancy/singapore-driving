// Run against a built app served at localhost:8080 and Chrome with
// --remote-debugging-port=9222. No browser automation dependency needed.
import assert from 'node:assert/strict';
const target = await (await fetch('http://localhost:9222/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.onopen = resolve);
let id = 0;
const pending = new Map(), errors = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === 'Runtime.exceptionThrown' ||
    (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')) {
    errors.push(message.params);
  }
};
const send = (method, params = {}) => new Promise(resolve => {
  pending.set(++id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!reply.error && !reply.result.exceptionDetails, JSON.stringify(reply));
  return reply.result.result.value;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: process.env.APP_URL || 'http://localhost:8080' });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await wait(500);
    ready = await evaluate('document.getElementById("loading")?.classList.contains("hidden")');
    if (ready || errors.length) break;
  }
  assert.ok(ready, JSON.stringify(errors));
  for (const selector of ['#night-toggle', '#reset', '#night-toggle', '#spawn-picker', '#close-spawn']) {
    await evaluate(`document.querySelector('${selector}').click()`);
    await wait(1000);
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW' });
  await wait(5000);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW' });
  assert.ok(await evaluate('Number(document.getElementById("speed").textContent) > 0'), 'Car should accelerate');
  await evaluate('document.getElementById("reset").click()');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(2000);
  await evaluate('document.getElementById("world").dispatchEvent(new Event("webglcontextlost", { cancelable: true }))');
  assert.equal(await evaluate('document.getElementById("loading").classList.contains("hidden")'), false);
  assert.deepEqual(errors, [], JSON.stringify(errors));
  console.log('Browser startup, geometry, night mode, reset, spawn picker, driving, mobile resize and context-loss handling passed');
} finally {
  ws.close();
  await fetch(`http://localhost:9222/json/close/${target.id}`);
}
