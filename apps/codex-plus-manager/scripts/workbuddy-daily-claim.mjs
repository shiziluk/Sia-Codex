import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const port = Number(process.env.WORKBUDDY_CDP_PORT || 39223);
const executable =
  process.env.WORKBUDDY_EXE ||
  path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy", "app", "WorkBuddy.exe");

async function pageTarget() {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    return targets.find((entry) => entry.type === "page" && entry.title === "WorkBuddy") || null;
  } catch {
    return null;
  }
}

async function ensureTarget() {
  const existing = await pageTarget();
  if (existing) return existing;
  await access(executable);
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    detached: false,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const target = await pageTarget();
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`WorkBuddy did not expose CDP on port ${port}`);
}

const target = await ensureTarget();
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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
}
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
await send("Runtime.enable");

const result = await evaluate(`(async () => {
  const shadow = document.querySelector('.daily-checkin .wb-slot')?.shadowRoot;
  if (!shadow) return { ok: false, status: 'missing', message: 'WorkBuddy check-in shadow root not found' };
  const dots = [...shadow.querySelectorAll('.dot')];
  dots[0]?.click();
  const switchDeadline = Date.now() + 5000;
  while (Date.now() < switchDeadline) {
    const text = shadow.querySelector('.cb')?.innerText || '';
    if (text.includes('Buddy加油站')) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const button = shadow.querySelector('#go');
  const before = shadow.querySelector('.cb')?.innerText || shadow.textContent || '';
  if (!button) return { ok: false, status: 'missing', message: 'WorkBuddy check-in button not found', before };
  if (
    button.getAttribute('data-done') === '1' ||
    /已领取|claimed today|today's gift claimed/i.test(before) ||
    !before.includes('立即领取')
  ) {
    return { ok: true, status: 'already_claimed', message: '今天已经领取过', before };
  }
  button.click();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const text = shadow.querySelector('.cb')?.innerText || shadow.textContent || '';
    const tip = shadow.querySelector('#tt')?.textContent || '';
    if (button.getAttribute('data-done') === '1' || /领取成功|已领取|claimed/i.test(text) || /失败|error|try again/i.test(tip)) {
      const failed = /失败|error|try again/i.test(tip);
      return {
        ok: !failed,
        status: failed ? 'failed' : 'claimed',
        message: tip || text,
        before,
        after: text,
        done: button.getAttribute('data-done'),
      };
    }
  }
  return {
    ok: false,
    status: 'uncertain',
    message: '领取请求后 20 秒内没有看到明确成功或失败状态',
    before,
    after: shadow.querySelector('.cb')?.innerText || shadow.textContent || '',
  };
})()`);
console.log(JSON.stringify(result, null, 2));
socket.close();
if (!result?.ok) process.exitCode = 1;
