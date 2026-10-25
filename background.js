// Keep track of model URLs seen in network requests, including requests made before the popup opens.
const MAX_URLS = 30;
chrome.webRequest.onCompleted.addListener((details) => {
  try {
    const u = new URL(details.url);
    if (u.hostname !== 'tripo-data.rg1.data.tripo3d.com' || !/\.glb$/i.test(u.pathname)) return;
    chrome.storage.session.get({tripoGlbUrls: []}, ({tripoGlbUrls}) => {
      const urls = [details.url, ...(tripoGlbUrls || []).filter(x => x !== details.url)].slice(0, MAX_URLS);
      chrome.storage.session.set({tripoGlbUrls: urls});
    });
  } catch (_) {}
}, {urls: ["https://tripo-data.rg1.data.tripo3d.com/*"]});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'TRIPO_GET_CAPTURED_URLS') {
    chrome.storage.session.get({tripoGlbUrls: []}, ({tripoGlbUrls}) => sendResponse({urls: tripoGlbUrls || []}));
    return true;
  }
});
