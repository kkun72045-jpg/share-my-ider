interface PageImage {
  url: string;
  alt: string;
  width: number;
  height: number;
}

/** Runs only after the user explicitly requests images from the active page. */
function collectPageImages(): PageImage[] {
  const found: PageImage[] = [];
  const seen = new Set<string>();
  for (const image of Array.from(document.images)) {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width < 120 || height < 120 || !image.currentSrc) continue;
    let source: URL;
    try { source = new URL(image.currentSrc); } catch { continue; }
    if (!['http:', 'https:'].includes(source.protocol) || seen.has(source.href)) continue;
    seen.add(source.href);
    found.push({ url: source.href, alt: image.alt.trim().slice(0, 100), width, height });
    if (found.length === 12) break;
  }
  return found;
}

/** Lists metadata only. Picking an image delegates to the existing import confirmation. */
export function setupPageImages(onPick: (url: string) => void): void {
  const open = document.getElementById('page-images-open') as HTMLButtonElement | null;
  const close = document.getElementById('page-images-close') as HTMLButtonElement | null;
  const panel = document.getElementById('page-images-panel');
  const list = document.getElementById('page-images-list');
  const status = document.getElementById('page-images-status');
  if (!open || !close || !panel || !list || !status || open.dataset.initialized === 'true') return;
  open.dataset.initialized = 'true';
  let requestId = 0;
  const idleLabel = open.textContent ?? '选网页图片';

  close.addEventListener('click', () => {
    requestId += 1;
    panel.hidden = true;
    open.disabled = false;
    open.textContent = idleLabel;
    open.setAttribute('aria-expanded', 'false');
    open.focus();
  });

  open.addEventListener('click', async () => {
    const currentRequest = ++requestId;
    panel.hidden = false;
    list.replaceChildren();
    open.setAttribute('aria-expanded', 'true');
    status.textContent = '正在读取当前网页的图片名称与尺寸…';
    if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.tabs?.query || !chrome.scripting?.executeScript) {
      status.textContent = '请在支持网页选图的浏览器插件面板中使用。';
      return;
    }
    open.disabled = true;
    open.textContent = '读取中…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (currentRequest !== requestId) return;
      if (tab?.id === undefined || (tab.url && !/^https?:\/\//i.test(tab.url))) {
        status.textContent = '此页面无法选图，请先打开普通商品网页。';
        return;
      }
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageImages });
      if (currentRequest !== requestId) return;
      const candidates = results[0]?.result ?? [];
      if (!candidates.length) {
        status.textContent = '未找到已加载的大图。可先在网页中展开商品图片，再试一次。';
        return;
      }
      status.textContent = `找到 ${candidates.length} 张图片。选中后确认导入，此处不加载图片。`;
      for (const [index, image] of candidates.entries()) {
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'page-image-choice';
        const label = image.alt || `网页图片 ${index + 1}`;
        choose.textContent = `${label} · ${image.width}×${image.height}`;
        choose.addEventListener('click', () => {
          onPick(image.url);
          panel.hidden = true;
          open.setAttribute('aria-expanded', 'false');
        });
        list.append(choose);
      }
    } catch {
      if (currentRequest === requestId) status.textContent = '无法读取此页面。请从商品网页重新打开插件并重试，或添加本地图片。';
    } finally {
      if (currentRequest === requestId) {
        open.disabled = false;
        open.textContent = idleLabel;
      }
    }
  });
}
