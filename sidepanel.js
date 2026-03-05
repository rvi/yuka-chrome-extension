// === State ===
let algoliaApiKey = null;
let isScanning = false;
let seenYukaIds = new Set(); // dedup by Yuka product ID across a scan

// === DOM Elements ===
const loginScreen = document.getElementById("login-screen");
const mainScreen = document.getElementById("main-screen");
const tokenInput = document.getElementById("token-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");
const scanBtn = document.getElementById("scan-btn");
const manualSearch = document.getElementById("manual-search");
const searchBtn = document.getElementById("search-btn");
const statusBar = document.getElementById("status-bar");
const statusText = document.getElementById("status-text");
const resultsArea = document.getElementById("results-area");
const emptyState = document.getElementById("empty-state");
const productsList = document.getElementById("products-list");

// === Init ===
async function init() {
  const stored = await chrome.storage.local.get(["algoliaApiKey"]);
  if (stored.algoliaApiKey) {
    algoliaApiKey = stored.algoliaApiKey;
    showMainScreen();
  } else {
    showLoginScreen();
  }
}

// === Screens ===
function showLoginScreen() {
  loginScreen.classList.remove("hidden");
  mainScreen.classList.add("hidden");
}

function showMainScreen() {
  loginScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
}

// === Login ===
loginBtn.addEventListener("click", async () => {
  const key = tokenInput.value.trim();
  if (!key) {
    showError("Please paste your Algolia API key.");
    return;
  }

  // Basic sanity check: should be a long base64-like string
  if (key.length < 40) {
    showError("That doesn't look like a valid Algolia key — it should be a long base64 string.");
    return;
  }

  setLoginLoading(true);
  hideError();

  try {
    // Validate by doing a quick live search against Algolia
    const response = await sendMessage({ type: "VALIDATE_KEY", apiKey: key });

    if (!response.success) {
      const msg = response.error || "Key validation failed";
      if (msg.includes("403")) {
        throw new Error(
          "Key rejected (403). Make sure you copied the full apiKey value from curl 3 — it's the long base64 string in the request body, not the Firebase token."
        );
      }
      throw new Error(msg);
    }

    algoliaApiKey = key;
    await chrome.storage.local.set({ algoliaApiKey: key });
    showMainScreen();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoginLoading(false);
  }
});

function setLoginLoading(loading) {
  loginBtn.disabled = loading;
  loginBtn.querySelector(".btn-text").classList.toggle("hidden", loading);
  loginBtn.querySelector(".btn-loading").classList.toggle("hidden", !loading);
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove("hidden");
}

function hideError() {
  loginError.classList.add("hidden");
}

// === Logout ===
logoutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(["algoliaApiKey"]);
  algoliaApiKey = null;
  tokenInput.value = "";
  productsList.innerHTML = "";
  productsList.classList.add("hidden");
  emptyState.classList.remove("hidden");
  showLoginScreen();
});

// === Scan Page ===
scanBtn.addEventListener("click", async () => {
  if (isScanning) return;
  isScanning = true;

  showStatus("Scanning page for products...");
  scanBtn.disabled = true;

  try {
    // Resolve the active tab from the side panel context, where currentWindow
    // correctly refers to the browser window the panel is attached to.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("Could not find the active tab.");

    const response = await sendMessage({ type: "EXTRACT_PRODUCTS", tabId: tab.id });

    if (!response.success) {
      throw new Error(response.error || "Failed to extract products");
    }

    const products = response.products || [];

    if (products.length === 0) {
      showStatus("No products found on this page.");
      setTimeout(() => hideStatus(), 3000);
      return;
    }

    showStatus(`Found ${products.length} products. Looking up scores...`);
    emptyState.classList.add("hidden");
    productsList.classList.remove("hidden");
    productsList.innerHTML = "";
    seenYukaIds.clear();

    // Create placeholder cards
    for (const name of products) {
      const card = createProductCard(name, null, true);
      productsList.appendChild(card);
    }

    // Search each product
    let completed = 0;
    const concurrency = 3;
    const queue = [...products];

    async function processNext() {
      if (queue.length === 0) return;
      const name = queue.shift();

      try {
        const result = await searchProduct(name);
        updateProductCard(name, result ? result.hit : null, result ? result.matchedQuery : null);
      } catch (err) {
        updateProductCard(name, null, null);
      }

      completed++;
      showStatus(`Looking up scores... (${completed}/${products.length})`);

      if (completed === products.length) {
        hideStatus();
        addSummaryBar();
      }

      await processNext();
    }

    // Launch concurrent workers
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(processNext());
    }
    await Promise.all(workers);

  } catch (err) {
    showStatus(`Error: ${err.message}`);
    setTimeout(() => hideStatus(), 4000);
  } finally {
    isScanning = false;
    scanBtn.disabled = false;
  }
});

// === Manual Search ===
searchBtn.addEventListener("click", () => doManualSearch());
manualSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doManualSearch();
});

async function doManualSearch() {
  const query = manualSearch.value.trim();
  if (!query) return;

  showStatus(`Searching for "${query}"...`);
  emptyState.classList.add("hidden");
  productsList.classList.remove("hidden");

  // Add loading card at top
  const card = createProductCard(query, null, true);
  productsList.insertBefore(card, productsList.firstChild);

  try {
    const result = await searchProduct(query);
    updateProductCard(query, result ? result.hit : null, result ? result.matchedQuery : null);
  } catch (err) {
    updateProductCard(query, null, null);
  }

  hideStatus();
  manualSearch.value = "";
}

// === API ===

/**
 * Build a ranked list of search queries to try for a product name.
 *
 * Strategy (in order):
 *  1. Full name as-is
 *  2. ALL-CAPS words joined (usually the brand: "NUTELLA", "COCA COLA")
 *  3. Each individual ALL-CAPS word (e.g. just "NUTELLA")
 *  4. Last 2 significant words (brand often trails in EU descriptions)
 *  5. First 2 significant words
 *  6. Single last significant word
 *
 * Duplicates and empty strings are removed.
 */
function buildSearchQueries(name) {
  const queries = [name];

  // ALL-CAPS words are almost always brand names on European product pages
  const capsWords = (name.match(/\b[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜÇ]{2,}\b/g) || []);
  if (capsWords.length > 0) {
    queries.push(capsWords.join(" "));        // e.g. "COCA COLA ZERO"
    capsWords.forEach((w) => queries.push(w)); // e.g. "NUTELLA" alone
  }

  // Significant words = length > 2, not pure stop-words
  const stopWords = new Set([
    "the","and","for","with","aux","les","des","une","et","de","du",
    "le","la","au","en","par","sur","pas","non","per","con","von","mit",
    "for","van","der","den","het","een","los","las","del","sin",
  ]);
  const sigWords = name
    .split(/[\s,/|·•\-–—]+/)
    .map((w) => w.replace(/[()[\]{}*&%$#@!?<>]/g, "").trim())
    .filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()));

  if (sigWords.length >= 3) {
    queries.push(sigWords.slice(0, 2).join(" "));           // first 2 sig words
    queries.push(sigWords.slice(-2).join(" "));             // last 2 sig words
  }
  if (sigWords.length >= 2) {
    queries.push(sigWords[sigWords.length - 1]);            // last sig word
    queries.push(sigWords[0]);                              // first sig word
  }

  // Deduplicate (case-insensitive) while preserving order
  const seen = new Set();
  return queries.filter((q) => {
    const k = q.toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Try each query in turn, stopping at the first that returns hits.
 * Returns { hit, matchedQuery } or null.
 */
async function searchProduct(originalName) {
  const queries = buildSearchQueries(originalName);

  for (const query of queries) {
    const response = await sendMessage({
      type: "SEARCH_PRODUCTS",
      apiKey: algoliaApiKey,
      query,
    });

    if (!response.success) throw new Error(response.error);

    const hits = response.data.hits || [];
    if (hits.length > 0) {
      return { hit: hits[0], matchedQuery: query };
    }
  }

  return null; // nothing found across all fallbacks
}

// === UI Helpers ===
function createProductCard(name, product, loading = false) {
  const card = document.createElement("div");
  card.className = `product-card ${loading ? "loading" : ""}`;
  card.dataset.searchName = name;

  if (loading) {
    card.innerHTML = `
      <div class="score-badge score-unknown">
        <span class="spinner-sm"></span>
      </div>
      <div class="product-info">
        <div class="product-name">${escapeHtml(name)}</div>
        <div class="product-score-label label-unknown">Looking up...</div>
      </div>
    `;
  } else {
    renderProductCard(card, name, product);
  }

  return card;
}

function updateProductCard(searchName, product, matchedQuery) {
  const card = productsList.querySelector(`[data-search-name="${CSS.escape(searchName)}"]`);
  if (!card) return;

  // Deduplicate: if this Yuka product was already shown, remove the card silently
  if (product) {
    const yukaId = product.hashId || product.objectID || null;
    if (yukaId) {
      if (seenYukaIds.has(yukaId)) {
        card.remove();
        return;
      }
      seenYukaIds.add(yukaId);
    }
  }

  card.classList.remove("loading");
  renderProductCard(card, searchName, product, matchedQuery);
}

function renderProductCard(card, searchName, product, matchedQuery) {
  if (!product || product.grade == null) {
    card.innerHTML = `
      <div class="score-badge score-unknown">?</div>
      <div class="product-info">
        <div class="product-name">${escapeHtml(searchName)}</div>
        <div class="product-score-label label-unknown">Not found in Yuka</div>
      </div>
    `;
    return;
  }

  const score = product.grade;
  const { className, label } = getScoreInfo(score);
  const yukaName = product.name || searchName;
  const brand = product.brand || "";

  // Show which query actually matched if it was a fallback (not the original name)
  const usedFallback = matchedQuery && matchedQuery.toLowerCase() !== searchName.toLowerCase();

  card.innerHTML = `
    <div class="score-badge ${className}">${Math.round(score)}</div>
    <div class="product-info">
      <div class="product-name">${escapeHtml(yukaName)}</div>
      ${brand ? `<div class="product-brand">${escapeHtml(brand)}</div>` : ""}
      ${usedFallback ? `<div class="searched-name">via "${escapeHtml(matchedQuery)}"</div>` : ""}
      <div class="product-score-label label-${className.replace("score-", "")}">${label}</div>
    </div>
  `;
}

function getScoreInfo(score) {
  if (score > 85) return { className: "score-excellent", label: "Excellent" };
  if (score > 70) return { className: "score-good", label: "Good" };
  if (score > 30) return { className: "score-mediocre", label: "Mediocre" };
  return { className: "score-bad", label: "Bad" };
}

function addSummaryBar() {
  // Remove existing summary
  const existing = productsList.querySelector(".summary-bar");
  if (existing) existing.remove();
  const existingInfo = productsList.querySelector(".scan-info");
  if (existingInfo) existingInfo.remove();

  const cards = productsList.querySelectorAll(".product-card");
  let excellent = 0, good = 0, mediocre = 0, bad = 0, unknown = 0;

  cards.forEach((card) => {
    const badge = card.querySelector(".score-badge");
    if (!badge) return;
    if (badge.classList.contains("score-excellent")) excellent++;
    else if (badge.classList.contains("score-good")) good++;
    else if (badge.classList.contains("score-mediocre")) mediocre++;
    else if (badge.classList.contains("score-bad")) bad++;
    else unknown++;
  });

  const total = cards.length;
  const found = total - unknown;

  const info = document.createElement("div");
  info.className = "scan-info";
  info.textContent = `${found} of ${total} products found in Yuka`;

  const summary = document.createElement("div");
  summary.className = "summary-bar";

  if (excellent > 0) summary.innerHTML += `<span class="summary-chip chip-excellent">${excellent} Excellent</span>`;
  if (good > 0) summary.innerHTML += `<span class="summary-chip chip-good">${good} Good</span>`;
  if (mediocre > 0) summary.innerHTML += `<span class="summary-chip chip-mediocre">${mediocre} Mediocre</span>`;
  if (bad > 0) summary.innerHTML += `<span class="summary-chip chip-bad">${bad} Bad</span>`;
  if (unknown > 0) summary.innerHTML += `<span class="summary-chip chip-unknown">${unknown} Not found</span>`;

  productsList.insertBefore(summary, productsList.firstChild);
  productsList.insertBefore(info, summary);
}

function showStatus(text) {
  statusBar.classList.remove("hidden");
  statusText.textContent = text;
}

function hideStatus() {
  statusBar.classList.add("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// === Messaging ===
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response || { success: false, error: "No response" });
    });
  });
}

// === Start ===
init();
