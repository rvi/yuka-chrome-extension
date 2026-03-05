// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Set side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Algolia constants
const ALGOLIA_APP_ID = "M8UJG2X7HL";
const ALGOLIA_ENDPOINT = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/prod_product/query`;

// Listen for messages from side panel and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VALIDATE_KEY") {
    // Do a lightweight test search to validate the key
    searchProducts(message.apiKey, "water")
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
    (async () => {
      const tabId = message.tabId;
      if (!tabId) {
        sendResponse({ success: false, error: "No tab ID provided." });
        return;
      }

      // First attempt
      const first = await sendToContentScript(tabId, { type: "EXTRACT_PRODUCTS" });
      if (first !== null) {
        sendResponse(first);
        return;
      }

      // Content script not ready — inject it then retry once
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      } catch (err) {
        sendResponse({ success: false, error: `Could not inject content script: ${err.message}` });
        return;
      }

      const second = await sendToContentScript(tabId, { type: "EXTRACT_PRODUCTS" });
      if (second !== null) {
        sendResponse(second);
      } else {
        sendResponse({ success: false, error: "Content script did not respond after injection." });
      }
    })();
    return true;
  }
});

/**
 * Send a message to a tab's content script.
 * Returns the response, or null if the content script isn't loaded yet.
 */
function sendToContentScript(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null); // not ready
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Search Yuka's Algolia product index.
 *
 * Matches the format from curl 3:
 *   POST /1/indexes/prod_product/query
 *   Headers: X-Algolia-Application-Id only
 *   Body:    { apiKey: "<secured_key>", params: "..." }
 *
 * The secured key already encodes filters (grades, countries, exclusions, etc.)
 * so we only add query-level params in `params`.
 */
async function searchProducts(apiKey, query) {
  const params = [
    "analytics=true",
    `facets=${encodeURIComponent('["brand"]')}`,
    "filters=statistics.us.scan_count%3E%3D10%20AND%20main_scan_countries:us",
    "hitsPerPage=5",
    `query=${encodeURIComponent(query)}`,
  ].join("&");

  const response = await fetch(ALGOLIA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Algolia-Application-Id": ALGOLIA_APP_ID,
      "User-Agent": "Algolia for Swift (7.0.5); iOS (26.3)",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: JSON.stringify({ apiKey, params }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Algolia search failed: ${response.status}${body ? " — " + body.slice(0, 120) : ""}`);
  }

  return await response.json();
}
