function getModelUrls() {
  const urls = performance.getEntriesByType('resource')
    .map(entry => entry.name)
    .filter(raw => {
      try {
        const u = new URL(raw);
        return u.hostname === 'tripo-data.rg1.data.tripo3d.com' && /\.glb$/i.test(u.pathname);
      } catch (_) { return false; }
    });
  return [...new Set(urls)];
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'TRIPO_FIND_GLB') sendResponse({urls: getModelUrls(), page: location.href});
});
