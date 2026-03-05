// Content script: extracts product names visible in the current viewport

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_PRODUCTS") {
    sendResponse({ success: true, products: extractProductNames() });
  }
  return true;
});

/**
 * Returns true if the element overlaps the viewport and isn't hidden.
 * Does NOT check opacity — cards on Target/Instacart animate in and can
 * have mid-transition opacity values that would cause false negatives.
 */
function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth  || document.documentElement.clientWidth;
  if (rect.bottom < 0 || rect.top  > vh) return false;
  if (rect.right  < 0 || rect.left > vw) return false;

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;

  return true;
}

/**
 * Extract the most likely product name from a product link element.
 * Avoids using full textContent which includes price, rating, etc.
 */
function getTextFromLink(a) {
  // 1. aria-label on the link itself (cleanest — set for accessibility)
  const aria = (a.getAttribute("aria-label") || "").trim();
  if (isValidProductText(aria)) return aria;

  // 2. A child element explicitly labelled as title/name
  const titleChild = a.querySelector(
    '[data-test*="title"], [data-test*="Title"], [data-test*="name"], ' +
    '[data-testid*="title"], [data-testid*="name"], ' +
    'h1, h2, h3, h4'
  );
  if (titleChild) {
    const text = titleChild.textContent.trim();
    if (isValidProductText(text)) return text;
  }

  // 3. First non-empty line of text content (title is usually first in DOM order)
  const firstLine = (a.textContent || "")
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .find((l) => isValidProductText(l));
  if (firstLine) return firstLine;

  return null;
}

function extractProductNames() {
  const products = new Set();

  // ── Strategy 1: Explicit named selectors ──────────────────────────────────
  const selectors = [
    // Generic
    '[data-product-name]',
    '[data-item-name]',
    '.product-name',
    '.product-title',
    '.product__title',
    '.product-item-name',
    '.product-card__title',
    '.product-card-title',
    // Amazon
    '.s-result-item h2 a span',
    '.a-size-medium.a-color-base.a-text-normal',
    '.a-size-base-plus.a-color-base.a-text-normal',
    '#productTitle',
    // Walmart
    '[data-automation-id="product-title"]',
    // Target — multiple variants seen across versions
    '[data-test="product-title"]',
    'a[data-test="product-title"]',
    '[data-test*="ProductTitle"]',
    '[data-test*="product-title"]',
    // Instacart
    '[data-testid="item_name"]',
    '[data-testid="product_card_name"]',
    '[data-testid="item-card-header"] span',
    '[data-testid*="item_name"]',
    '[data-testid*="product_name"]',
    // Generic testid patterns
    '[data-testid*="product"][data-testid*="name"]',
    '[data-testid*="item"][data-testid*="name"]',
    // Misc
    '.item-title',
    '.listing-title',
    'h2.product-name',
    'h3.product-name',
    '.card-title',
    '[itemprop="name"]',
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      if (!isInViewport(el)) return;
      const text = (el.getAttribute("data-product-name") || el.textContent || "").trim();
      if (isValidProductText(text)) products.add(text);
    });
  }

  // ── Strategy 2: Product links ─────────────────────────────────────────────
  // Detect <a href> pointing to product pages and extract the name cleanly
  // (not the full textContent which includes price/rating noise).
  const productLinkPatterns = [
    /\/products?\//i,
    /\/items?\//i,
    /\/p\//i,           // Target: /p/wonder-bread/-/A-12345
    /\/dp\//i,          // Amazon: /dp/B00XXXXX
    /[?&]product_id=/i,
  ];

  document.querySelectorAll("a[href]").forEach((a) => {
    if (!isInViewport(a)) return;
    const href = a.getAttribute("href") || "";
    if (!productLinkPatterns.some((re) => re.test(href))) return;
    const text = getTextFromLink(a);
    if (text) products.add(text);
  });

  // ── Strategy 3: aria-label on card elements ───────────────────────────────
  document.querySelectorAll(
    '[aria-label][role="listitem"], [aria-label][role="article"], [aria-label][role="button"]'
  ).forEach((el) => {
    if (!isInViewport(el)) return;
    const text = (el.getAttribute("aria-label") || "").trim();
    if (isValidProductText(text)) products.add(text);
  });

  // ── Strategy 4: Heuristic — headings inside product containers ────────────
  document.querySelectorAll(
    '[class*="product"], [class*="item-card"], [class*="ItemCard"], [class*="ProductCard"]'
  ).forEach((container) => {
    if (!isInViewport(container)) return;
    const heading = container.querySelector("h1, h2, h3, h4");
    if (heading && isInViewport(heading)) {
      const text = heading.textContent.trim();
      if (isValidProductText(text) && !text.includes("\n")) products.add(text);
    }
  });

  // ── Strategy 5: JSON-LD (single-product detail pages only) ───────────────
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      extractSingleProductFromJsonLd(JSON.parse(script.textContent), products);
    } catch (e) { /* ignore */ }
  });

  return [...products].slice(0, 50);
}

function isValidProductText(text) {
  return (
    typeof text === "string" &&
    text.length > 2 &&
    text.length < 200 &&
    !/^\s*$/.test(text)
  );
}

function extractSingleProductFromJsonLd(data, products) {
  if (Array.isArray(data)) {
    data.forEach((item) => extractSingleProductFromJsonLd(item, products));
    return;
  }
  if (data && typeof data === "object") {
    if (data["@type"] === "Product" && data.name) {
      products.add(data.name.trim());
    }
    if (data["@graph"]) {
      data["@graph"].forEach((item) => extractSingleProductFromJsonLd(item, products));
    }
  }
}
