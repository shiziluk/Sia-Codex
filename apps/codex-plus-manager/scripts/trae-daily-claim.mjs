const port = Number(process.env.TRAE_CDP_PORT || 39222);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === "page" && entry.title?.includes("TRAE CN"));
if (!target) {
  throw new Error("Trae CN page target not found; start a headless Trae task first");
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
});
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || JSON.stringify(response.exceptionDetails));
  }
  return response.result?.value;
}
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
await send("Runtime.enable");
const result = await evaluate(`(async () => {
  const card = document.querySelector('section[aria-label*="每日签到得 100 积分"]');
  if (!card) return { ok: false, status: 'missing', message: 'Trae daily check-in card not found' };
  const before = card.innerText || '';
  const button = [...card.querySelectorAll('button')].find(item => (item.textContent || '').trim() === '签到');
  if (!button) {
    if (/今日已签到|已经签到|已参与签到|已签到/.test(before)) {
      return { ok: true, status: 'already_claimed', message: '今天已经签到过', before };
    }
    return { ok: false, status: 'missing', message: 'Trae check-in button not found', before };
  }
  const rect = button.getBoundingClientRect();
  if (!rect.width || !rect.height) return { ok: false, status: 'hidden', message: 'Trae check-in button is hidden', before };
  button.click();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = card.innerText || '';
    const body = document.body?.innerText || '';
    if (/签到成功|今日已签到|已经签到|已参与签到|已签到/.test(after + ' ' + body)) {
      return { ok: true, status: 'claimed', message: '签到成功', before, after };
    }
    if (/签到失败|请稍后重试/.test(body)) {
      return { ok: false, status: 'failed', message: '签到失败', before, after };
    }
  }
  return { ok: false, status: 'uncertain', message: '签到后 20 秒内没有看到明确结果', before };
})()`);
console.log(JSON.stringify(result, null, 2));
socket.close();
if (!result?.ok) process.exitCode = 1;
