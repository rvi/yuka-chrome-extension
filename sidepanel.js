// === State ===
let algoliaApiKey = null;
let isScanning = false;

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
  const stored = await chrome.storage.local.get(["yukaToken", "algoliaApiKey"]);
  if (stored.yukaToken && stored.algoliaApiKey) {
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
  const token = tokenInput.value.trim();
  if (!token) {
    showError("Please enter your authentication token.");
    return;
  }

  setLoginLoading(true);
  hideError();

  try {
    const response = await sendMessage({ type: "GENERATE_ALGOLIA_KEY", token });

    if (!response.success) {
      throw new Error(response.error || "Failed to authenticate");
    }

    // The response should contain the Algolia API key
    const data = response.data;
    algoliaApiKey = extractApiKey(data);

    if (!algoliaApiKey) {
      throw new Error("Could not extract API key from response");
    }

    // Store credentials
    await chrome.storage.local.set({
      yukaToken: token,
      algoliaApiKey: algoliaApiKey,
    });

    showMainScreen();
  } catch (err) {
    showError(`Authentication failed: ${err.message}`);
  } finally {
    setLoginLoading(false);
  }
});

function extractApiKey(data) {
  // The key generation endpoint likely returns the key in various formats
  if (typeof data === "string") return data;
  if (data.apiKey) return data.apiKey;
  if (data.key) return data.key;
  if (data.data && data.data.apiKey) return data.data.apiKey;
  if (data.data && data.data.key) return data.data.key;
  // If the response is an object, try to find any key-like field
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && v.length > 20) return v;
  }
  return null;
}

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
  await chrome.storage.local.remove(["yukaToken", "algoliaApiKey"]);
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
    const response = await sendMessage({ type: "EXTRACT_PRODUCTS" });

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
        updateProductCard(name, result);
      } catch (err) {
        updateProductCard(name, null);
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
    updateProductCard(query, result);
  } catch (err) {
    updateProductCard(query, null);
  }

  hideStatus();
  manualSearch.value = "";
}

// === API ===
async function searchProduct(query) {
  const response = await sendMessage({
    type: "SEARCH_PRODUCTS",
    apiKey: algoliaApiKey,
    query: query,
  });

  if (!response.success) {
    throw new Error(response.error);
  }

  const hits = response.data.hits || [];
  if (hits.length === 0) return null;

  // Return best match
  return hits[0];
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

function updateProductCard(searchName, product) {
  const card = productsList.querySelector(`[data-search-name="${CSS.escape(searchName)}"]`);
  if (!card) return;

  card.classList.remove("loading");
  renderProductCard(card, searchName, product);
}

function renderProductCard(card, searchName, product) {
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
  const name = product.name || searchName;
  const brand = product.brand || "";

  card.innerHTML = `
    <div class="score-badge ${className}">${Math.round(score)}</div>
    <div class="product-info">
      <div class="product-name">${escapeHtml(name)}</div>
      ${brand ? `<div class="product-brand">${escapeHtml(brand)}</div>` : ""}
      ${name.toLowerCase() !== searchName.toLowerCase() ? `<div class="searched-name">Searched: ${escapeHtml(searchName)}</div>` : ""}
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
