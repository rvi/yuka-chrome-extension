// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Set side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages from side panel and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GENERATE_ALGOLIA_KEY") {
    generateAlgoliaKey(message.token)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "SEARCH_PRODUCTS") {
    searchProducts(message.apiKey, message.query)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "EXTRACT_PRODUCTS") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        sendResponse({ success: false, error: "No active tab" });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: "EXTRACT_PRODUCTS" }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
    });
    return true;
  }
});

async function generateAlgoliaKey(token) {
  const url = `https://goodtoucan.com/ALJPAW5/api/algolia/key/generate?token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "*/*",
      "X-Accept-Version": "3",
      "User-Agent": "Yuka/4.81 (yuca.scanner; build:1997; iOS 26.3.0) Alamofire/5.10.2",
    },
  });

  if (!response.ok) {
    throw new Error(`Key generation failed: ${response.status}`);
  }

  return await response.json();
}

async function searchProducts(apiKey, query) {
  const url = "https://m8ujg2x7hl-dsn.algolia.net/1/indexes/prod_product/query";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Algolia-Application-Id": "M8UJG2X7HL",
      "X-Algolia-API-Key": "98e6cf011633dee8dee398318c87e302",
    },
    body: JSON.stringify({
      apiKey: apiKey,
      params: `analytics=true&facets=[%22brand%22]&hitsPerPage=5&query=${encodeURIComponent(query)}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Product search failed: ${response.status}`);
  }

  return await response.json();
}
