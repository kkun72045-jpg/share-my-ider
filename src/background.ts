const MENU = 'realtime-fitting-pick';

// The browser opens the extension beside the current page; never a new app tab.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU, title: '在实时演算中试穿', contexts: ['image'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU || !info.srcUrl) return;
  try {
    const source = new URL(info.srcUrl);
    if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) return;
    if (tab?.windowId === undefined) return;
    // open() must run in the original user gesture, before awaiting storage work.
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    void chrome.storage.session.set({ pendingGarment: { url: source.href, createdAt: Date.now() } });
  } catch { /* Unsupported image URLs are ignored; local upload remains available. */ }
});
