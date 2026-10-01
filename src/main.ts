import './styles.css';
import { brokerOrigin, garmentSource, validateImage, MAX_GARMENTS, MAX_IMAGE_BYTES, SESSION_LIMIT_SECONDS, OperationGate } from './policy';
import type { EngineBridge, GarmentBytes } from './engine-contract';
import { setupPageImages } from './page-images';

const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};
const button = (id: string) => el<HTMLButtonElement>(id);
const local = el<HTMLVideoElement>('local-video');
const remote = el<HTMLVideoElement>('remote-video');
remote.muted = true;
const consent = el<HTMLInputElement>('privacy-consent');
const broker = el<HTMLInputElement>('broker-url');
const brokerAccess = document.getElementById('broker-access-token') as HTMLInputElement | null;
const description = el<HTMLTextAreaElement>('garment-description');
const fileInput = el<HTMLInputElement>('garment-input');
const cameraGate = new OperationGate();
const sessionGate = new OperationGate();
const extension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
type Garment = { id: string; file: File; url: string };
let garments: Garment[] = [];
let selected = '';
let camera: MediaStream | null = null;
let cameraStarting = false;
let connecting = false;
let live = false;
let updating = false;
let frame: HTMLIFrameElement | null = null;
let engine: EngineBridge | null = null;
let request: AbortController | null = null;
let timer = 0;
let hiddenTimer = 0;
let startedAt = 0;
let pendingUrl = '';

function status(message: string, tone = 'neutral') {
  el('status-message').textContent = message;
  el('status-message').dataset.tone = tone;
}
function updateControls() {
  button('camera-start').disabled = !!camera || cameraStarting || connecting || live;
  button('camera-stop').disabled = !camera && !cameraStarting;
  button('session-start').disabled = !camera || !selected || !consent.checked || connecting || live;
  button('session-stop').disabled = !connecting && !live;
  button('screenshot-download').disabled = !live || remote.readyState < 2 || !remote.videoWidth;
  consent.disabled = connecting || live;
  broker.disabled = connecting || live;
  if (brokerAccess) brokerAccess.disabled = connecting || live;
  fileInput.disabled = connecting || updating;
  el('local-empty').hidden = !!camera;
  el('remote-empty').hidden = live && remote.readyState >= 2;
  const caption = document.querySelector('.ai-stage .stage-footnote');
  if (caption) caption.textContent = live && remote.readyState >= 2 ? '模型生成画面' : '尚无生成画面';
}

function stop(message = '会话已结束，摄像头已关闭。') {
  sessionGate.cancel(); cameraGate.cancel();
  request?.abort(); request = null;
  engine?.stop(); engine = null;
  // Unload the SDK context even if its connect() promise is still pending.
  frame?.remove(); frame = null;
  camera?.getTracks().forEach(track => track.stop()); camera = null;
  const output = remote.srcObject;
  if (output && 'getTracks' in output && typeof output.getTracks === 'function') output.getTracks().forEach(track => track.stop());
  local.srcObject = null; remote.srcObject = null;
  remote.controls = false;
  cameraStarting = false; connecting = false; live = false; updating = false;
  clearInterval(timer); clearTimeout(hiddenTimer);
  el('session-state').textContent = '尚未开始';
  el('connection-status').textContent = '未连接模型';
  status(message); updateControls(); renderGarments();
}

async function startCamera() {
  const operation = cameraGate.begin(); cameraStarting = true; updateControls();
  status('正在请求摄像头权限。只开启本地预览，不上传画面。');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' } });
    if (!cameraGate.current(operation)) { stream.getTracks().forEach(track => track.stop()); return; }
    camera = stream; local.srcObject = stream;
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { if (camera === stream) stop('摄像头已断开，会话已停止。'); }));
    await local.play();
    if (!cameraGate.current(operation)) return;
    status('本地预览已就绪。选择服装并确认云端处理后，才会开始 AI 试衣。', 'success');
  } catch {
    if (cameraGate.current(operation)) stop('无法开启摄像头，请检查浏览器权限和设备占用。');
  } finally {
    if (cameraGate.current(operation)) { cameraStarting = false; updateControls(); }
  }
}

function renderGarments() {
  const list = el('garment-list'); list.replaceChildren();
  el('garment-empty').hidden = garments.length > 0;
  for (const item of garments) {
    const card = document.createElement('div'); card.className = `garment-card${item.id === selected ? ' is-selected' : ''}`;
    const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'garment-select';
    choose.setAttribute('aria-label', `选择 ${item.file.name}`); choose.setAttribute('aria-pressed', String(item.id === selected));
    choose.disabled = connecting || updating;
    const img = new Image(); img.src = item.url; img.alt = item.file.name;
    const name = document.createElement('span'); name.textContent = item.file.name;
    choose.append(img, name); choose.addEventListener('click', () => void selectGarment(item));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'garment-remove'; remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除 ${item.file.name}`); remove.disabled = connecting || updating || live;
    remove.addEventListener('click', () => {
      garments = garments.filter(g => g.id !== item.id); URL.revokeObjectURL(item.url);
      if (selected === item.id) selected = garments[0]?.id ?? '';
      renderGarments(); updateControls();
    });
    card.append(choose, remove); list.append(card);
  }
}
const garmentBytes = async (item: Garment): Promise<GarmentBytes> => ({ bytes: await item.file.arrayBuffer(), type: item.file.type, name: item.file.name });
const promptText = () => description.value.trim().slice(0, 400) || 'Try on the reference garment. Preserve the person, face and background.';

async function selectGarment(item: Garment) {
  if (connecting || updating) return;
  if (live && engine) {
    const activeEngine = engine; updating = true; renderGarments(); updateControls(); status('正在切换服装…');
    try {
      await activeEngine.update(await garmentBytes(item), promptText());
      if (engine !== activeEngine) return;
      selected = item.id; status('服装已发送，等待模型更新画面。', 'success');
    } catch { if (engine === activeEngine) status('服装切换未完成，可以重试或结束会话。', 'error'); }
    finally { if (engine === activeEngine) { updating = false; renderGarments(); updateControls(); } }
  } else { selected = item.id; renderGarments(); updateControls(); }
}

async function addFile(file: File) {
  if (garments.length >= MAX_GARMENTS) throw new Error('本次衣橱最多放 6 张图片，请先移除一些。');
  validateImage(file.type, file.size);
  const bitmap = await createImageBitmap(file);
  const pixels = bitmap.width * bitmap.height; bitmap.close();
  if (pixels > 24_000_000) throw new Error('图片分辨率过大，请缩小到 2400 万像素以下。');
  const item = { id: crypto.randomUUID(), file, url: URL.createObjectURL(file) };
  garments.push(item); if (!selected) selected = item.id;
  renderGarments(); updateControls();
}

async function brokerSettings(): Promise<{ base: string; headers: Record<string, string> }> {
  const base = brokerOrigin(broker.value);
  const access = brokerAccess?.value.trim() ?? '';
  if (base.startsWith('https:') && access.length < 32) throw new Error('请填写个人 HTTPS 凭证服务的访问码（至少 32 字符），不要填写模型 API 密钥。');
  if (extension && base.startsWith('https:')) {
    const allowed = await chrome.permissions.request({ origins: [`${base}/*`] });
    if (!allowed) throw new Error('需要允许连接你填写的凭证服务。');
  }
  return { base, headers: access ? { Authorization: `Bearer ${access}` } : {} };
}

async function checkConnection() {
  button('check-connection').disabled = true; el('broker-status').textContent = '正在检查…';
  try {
    const { base, headers } = await brokerSettings();
    const result = await fetch(`${base}/health`, { headers, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000) });
    const health = await result.json();
    if (!result.ok || !health.configured) throw new Error('not configured');
    el('broker-status').textContent = '凭证服务已就绪';
    status('服务可达。此检查未调用生成模型，也未验证账户额度。', 'success');
  } catch {
    el('broker-status').textContent = '尚未就绪';
    status('凭证服务未就绪。请检查服务地址、访问码和允许的扩展来源；电脑本机服务需先启动。', 'warning');
  } finally { button('check-connection').disabled = false; }
}

async function loadEngine(signal: AbortSignal): Promise<EngineBridge> {
  if (signal.aborted) throw new Error('引擎启动已取消。');
  const iframe = document.createElement('iframe'); iframe.hidden = true; iframe.title = '实时连接引擎';
  frame = iframe;
  return new Promise((resolve, reject) => {
    const fail = () => { clear(); reject(new Error('引擎启动已取消。')); };
    const timeout = setTimeout(fail, 15000);
    const clear = () => { clearTimeout(timeout); signal.removeEventListener('abort', fail); };
    signal.addEventListener('abort', fail, { once: true });
    iframe.addEventListener('load', () => {
      clear(); const bridge = iframe.contentWindow?.realtimeEngine;
      if (!signal.aborted && bridge) resolve(bridge); else reject(new Error('引擎未能加载。'));
    }, { once: true });
    iframe.addEventListener('error', () => { clear(); fail(); }, { once: true });
    iframe.src = new URL('./engine.html', location.href).href; document.body.append(iframe);
  });
}

async function startSession() {
  if (!camera || !consent.checked || !selected || connecting || live) return;
  const item = garments.find(g => g.id === selected); if (!item) return;
  const operation = sessionGate.begin(); const active = () => sessionGate.current(operation);
  const source = camera;
  request = new AbortController(); const signal = request.signal;
  connecting = true; updateControls(); renderGarments(); status('正在获取短期凭证并连接实时模型…');
  el('connection-status').textContent = '连接中'; el('session-duration').textContent = '00:00';
  const timeout = setTimeout(() => { if (active()) stop('连接超时，已关闭摄像头。请检查网络与账户额度后重试。'); }, 45000);
  try {
    const { base, headers } = await brokerSettings();
    if (!active() || signal.aborted) return;
    const response = await fetch(`${base}/api/token`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal });
    if (!response.ok) throw new Error('凭证服务拒绝了请求。');
    const token = await response.json();
    if (!active()) return;
    if (typeof token.apiKey !== 'string' || !token.apiKey) throw new Error('凭证格式无效。');
    const bridge = await loadEngine(signal); if (!active()) { bridge.stop(); return; }
    engine = bridge;
    const bytes = await garmentBytes(item);
    if (!active() || signal.aborted) { bridge.stop(); return; }
    await bridge.connect(source, token.apiKey, bytes, promptText(), {
      stream(output) {
        if (!active()) { output.getTracks().forEach(track => track.stop()); return; }
        remote.srcObject = output; void remote.play().catch(() => {
          if (!active()) return;
          remote.controls = true;
          status('请点击 AI 画面中的播放按钮。', 'warning');
        });
      },
      state(state) {
        if (!active()) return;
        const labels: Record<string, string> = { connecting: '连接中', connected: '已连接，等待画面', generating: '实时生成中', reconnecting: '正在重连', disconnected: '已断开' };
        el('connection-status').textContent = labels[state] ?? '连接状态更新';
        if (state === 'disconnected' && live) stop('模型连接已断开，摄像头已关闭。');
      },
      stats(fps, latency) {
        if (!active()) return;
        el('connection-status').textContent = `已连接${fps !== null ? ` · ${Math.round(fps)} FPS` : ''}${latency !== null ? ` · ${Math.round(latency)} ms` : ''}`;
      },
      ended() { if (active()) stop('模型服务结束了会话，摄像头已关闭。'); },
      error() { if (active()) stop('模型连接异常，已停止。请检查网络、账户额度和服务配置。'); }
    });
    if (!active()) { bridge.stop(); return; }
    clearTimeout(timeout); connecting = false; live = true; startedAt = Date.now();
    el('session-state').textContent = '会话进行中'; status('已连接模型。点击衣橱里的另一件服装即可切换，最长运行 3 分钟。', 'success');
    updateControls(); renderGarments();
    timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      el('session-duration').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      if (seconds >= SESSION_LIMIT_SECONDS) stop('已达到 3 分钟会话上限，摄像头已关闭。');
    }, 500);
  } catch { if (active()) stop('未能连接模型。请检查凭证服务、访问码、扩展来源和账户额度；没有生成试衣画面。'); }
  finally { clearTimeout(timeout); if (active()) { connecting = false; updateControls(); } }
}

async function importPendingImage() {
  if (!pendingUrl || !extension) return;
  let url: URL;
  try { url = garmentSource(pendingUrl); } catch { status('无法导入此地址，请改用本地图片。', 'error'); return; }
  button('import-image').disabled = true;
  try {
    // Permission is requested only inside this explicit user click, for this image origin.
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) { status('未授予此网站图片读取权限，你仍可手动上传服装图片。'); return; }
    const response = await fetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body) throw new Error('Image unavailable');
    const type = (response.headers.get('content-type') ?? '').split(';')[0];
    const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MB。');
        chunks.push(new Uint8Array(chunk.value));
      }
    } finally { await reader.cancel(); }
    validateImage(type, size);
    await addFile(new File(chunks, `网页服装.${type === 'image/jpeg' ? 'jpg' : type.split('/')[1]}`, { type }));
    pendingUrl = ''; el('pending-import').hidden = true; await chrome.storage.session?.remove('pendingGarment');
    status('服装已导入本次衣橱。尚未发送给模型服务。', 'success');
  } catch { status('图片读取失败，网站可能禁止跨站读取。请下载图片后手动选择。', 'warning'); }
  finally { button('import-image').disabled = false; }
}

button('camera-start').addEventListener('click', () => void startCamera());
button('camera-stop').addEventListener('click', () => stop());
button('session-start').addEventListener('click', () => void startSession());
button('session-stop').addEventListener('click', () => stop());
button('check-connection').addEventListener('click', () => void checkConnection());
button('import-image').addEventListener('click', () => void importPendingImage());
consent.addEventListener('change', updateControls);
remote.addEventListener('loadeddata', updateControls);
fileInput.accept = 'image/png,image/jpeg,image/webp';
fileInput.addEventListener('change', async () => {
  for (const file of Array.from(fileInput.files ?? [])) {
    try { await addFile(file); } catch (error) { status(error instanceof Error ? error.message : '无法读取图片。', 'warning'); break; }
  }
  fileInput.value = '';
});
for (const view of ['original', 'ai', 'compare']) button(`view-${view}`).addEventListener('click', () => {
  const stage = el('stage-workspace'); stage.classList.remove('view-original', 'view-ai');
  if (view !== 'compare') stage.classList.add(`view-${view}`);
  for (const choice of ['original', 'ai', 'compare']) button(`view-${choice}`).setAttribute('aria-pressed', String(choice === view));
});
button('screenshot-download').addEventListener('click', () => {
  if (!live || remote.readyState < 2 || !remote.videoWidth) return;
  const canvas = document.createElement('canvas'); canvas.width = remote.videoWidth; canvas.height = remote.videoHeight;
  const context = canvas.getContext('2d'); if (!context) return; context.drawImage(remote, 0, 0);
  canvas.toBlob(blob => {
    if (!blob) return;
    const link = document.createElement('a'); const url = URL.createObjectURL(blob); link.href = url;
    link.download = `实时演算-${new Date().toISOString().replace(/[:.]/g, '-')}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
});
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (document.hidden && (live || connecting || camera)) hiddenTimer = window.setTimeout(() => stop('页面在后台超过 15 秒，已自动停止并关闭摄像头。'), 15000);
});
window.addEventListener('pagehide', () => {
  stop(); for (const item of garments) URL.revokeObjectURL(item.url); garments = [];
});
el<HTMLInputElement>('extension-id').value = extension ? `${location.protocol}//${location.host}` : '开发预览：设置 DEV_ORIGIN=http://127.0.0.1:5173';
function showPendingGarment(pendingGarment: unknown) {
  if (!pendingGarment || typeof pendingGarment !== 'object' || !('createdAt' in pendingGarment) || !('url' in pendingGarment)) return;
  if (typeof pendingGarment.createdAt !== 'number' || typeof pendingGarment.url !== 'string' || Date.now() - pendingGarment.createdAt > 10 * 60 * 1000) return;
  try {
    const url = garmentSource(pendingGarment.url); pendingUrl = url.href;
    el('pending-source').textContent = url.hostname; el('pending-import').hidden = false;
  } catch { /* No untrusted HTML is rendered. */ }
}
if (extension) {
  void chrome.storage.session?.get('pendingGarment').then(({ pendingGarment }) => showPendingGarment(pendingGarment));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.pendingGarment) showPendingGarment(changes.pendingGarment.newValue);
  });
}
setupPageImages(url => showPendingGarment({ url, createdAt: Date.now() }));
document.getElementById('panel-close')?.addEventListener('click', async () => {
  stop('摄像头与连接已关闭。');
  if (brokerAccess) brokerAccess.value = '';
  const sidePanel = extension ? chrome.sidePanel as (typeof chrome.sidePanel & { close?: (options: { windowId: number }) => Promise<void> }) : undefined;
  if (sidePanel?.close) {
    try {
      const current = await chrome.windows.getCurrent();
      if (current.id !== undefined) { await sidePanel.close({ windowId: current.id }); return; }
    } catch { /* Older browser versions can still stop all media immediately. */ }
  }
  if (extension && !chrome.runtime.getManifest().side_panel) window.close();
  else status('摄像头与连接已关闭。可点击浏览器面板上的 × 收起。');
});
updateControls(); renderGarments();
