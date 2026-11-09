const form = document.querySelector('#connection-form');
const status = document.querySelector('#connection-status');
const button = form.querySelector('button');
const endpoint = '/api/ci/jenkins/connection';
let interacted = false;
form.addEventListener('input', () => { interacted = true; });
const showConnected = result => {
  status.textContent = `已连接：${result.repository} · ${result.username}。系统将自动读取该 Jenkins 任务的构建和失败日志。`;
};
form.addEventListener('submit', async event => {
  event.preventDefault(); interacted = true; button.disabled = true; status.textContent = '正在验证 Jenkins 访问…';
  const value = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MyDashboard-Action': '1' }, body: JSON.stringify(value) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '连接失败，请检查构建链接和账号');
    form.elements.password.value = ''; showConnected(result);
  } catch (error) { status.textContent = error.message; }
  finally { value.password = ''; button.disabled = false; }
});
button.disabled = false;
try {
  const response = await fetch(endpoint, { cache: 'no-store' });
  const result = await response.json();
  if (!interacted) {
    if (!response.ok) throw new Error('连接入口暂不可用');
    if (result.configured) {
      form.elements.repository.value = result.repository;
      form.elements.buildUrl.value = result.buildUrl;
      form.elements.username.value = result.username;
      status.textContent = '已有连接。系统读取时会自动验证访问状态；更换凭据可重新连接。';
    } else status.textContent = '尚未连接 Jenkins。';
  }
} catch { if (!interacted) status.textContent = '连接入口暂不可用，请确认中枢服务已启动。'; }
