// Content script: extracts product names visible in the current viewport

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_PRODUCTS") {
    sendResponse({ success: true, products: extractProductNames() });
  }
  return true;
});

/**
 * Returns true if the element overlaps the viewport and isn't hidden.
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
 * Returns true if the element is in the main content area of the page,
 * not inside a navigation bar, header, footer, sidebar, or modal.
 */
function isInMainContent(el) {
  let node = el;
  while (node && node !== document.body) {
    const tag = node.tagName && node.tagName.toLowerCase();
    if (tag === "nav" || tag === "header" || tag === "footer" || tag === "aside") return false;
    const role = (node.getAttribute("role") || "").toLowerCase();
    if (role === "navigation" || role === "banner" || role === "complementary") return false;
    const cls = (node.className || "").toLowerCase();
    const id  = (node.id || "").toLowerCase();
    // Common nav/chrome class patterns
    if (/\b(navbar|nav-bar|nav_bar|header|footer|sidebar|breadcrumb|modal|dialog|overlay|cookie|banner|account|login|menu|search-bar|facet|filter)\b/.test(cls + " " + id)) return false;
    node = node.parentElement;
  }
  return true;
}

/**
 * Returns true if the text looks like a product name.
 * Rejects review summaries, nav strings, UI labels, and search hints.
 */
function looksLikeProductName(text) {
  if (!isValidProductText(text)) return false;

  // Starts with a digit → likely a rating, count, or price ("8 avis...", "3 pour 2€")
  if (/^\d/.test(text.trim())) return false;

  // Review/rating patterns (FR/EN)
  if (/avis pour une note|note moyenne|sur\s+5|étoile|stars?\s+out\s+of/i.test(text)) return false;

  // Search/navigation UI patterns
  if (/affinez votre recherche|mon compte|se connecter|créer un compte|panier|livraison offerte|voir le panier/i.test(text)) return false;

  // Parenthetical counts like "pain (428)" or filter labels
  if (/\(\d+\)/.test(text)) return false;

  // Colon-separated filter labels like "Marque : Nutella"
  if (/^[\w\s]+\s*:\s*".+"/.test(text)) return false;

  return true;
}

/**
 * Extract the most likely product name from a product link element.
 */
function getTextFromLink(a) {
  // 1. aria-label on the link (cleanest — set for accessibility, usually just the name)
  const aria = (a.getAttribute("aria-label") || "").trim();
  if (looksLikeProductName(aria)) return aria;

  // 2. A child element explicitly labelled as title/name
  const titleChild = a.querySelector(
    '[data-test*="title"], [data-test*="Title"], [data-test*="name"], ' +
    '[data-testid*="title"], [data-testid*="name"], ' +
    'h1, h2, h3, h4'
  );
  if (titleChild) {
    const text = titleChild.textContent.trim();
    if (looksLikeProductName(text)) return text;
  }

  // 3. First non-empty line of text content
  const firstLine = (a.textContent || "")
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .find((l) => looksLikeProductName(l));
  if (firstLine) return firstLine;

  return null;
}

/**
 * If the page is a single-product detail page (identified by a JSON-LD
 * @type:Product block), return just that product name.
 * Returns null on listing/search pages.
 */
function extractDetailPageProduct() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const name = findProductNameInJsonLd(JSON.parse(script.textContent));
      if (name) return name;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function findProductNameInJsonLd(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      const name = findProductNameInJsonLd(item);
      if (name) return name;
    }
    return null;
  }
  if (data && typeof data === "object") {
    if (data["@type"] === "Product" && data.name) return data.name.trim();
    if (data["@graph"]) return findProductNameInJsonLd(data["@graph"]);
  }
  return null;
}

function extractProductNames() {
  // On single-product detail pages use JSON-LD only — no DOM scraping.
  const jsonLdProduct = extractDetailPageProduct();
  if (jsonLdProduct) return [jsonLdProduct];

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
    // Target
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
      if (!isInViewport(el) || !isInMainContent(el)) return;
      const text = (el.getAttribute("data-product-name") || el.textContent || "").trim();
      if (looksLikeProductName(text)) products.add(text);
    });
  }

  // ── Strategy 2: Product links ─────────────────────────────────────────────
  const productLinkPatterns = [
    /\/products?\//i,
    /\/items?\//i,
    /\/p\//i,
    /\/dp\//i,
    /[?&]product_id=/i,
  ];

  document.querySelectorAll("a[href]").forEach((a) => {
    if (!isInViewport(a) || !isInMainContent(a)) return;
    const href = a.getAttribute("href") || "";
    if (!productLinkPatterns.some((re) => re.test(href))) return;
    const text = getTextFromLink(a);
    if (text) products.add(text);
  });

  // ── Strategy 3: aria-label on card elements ───────────────────────────────
  document.querySelectorAll(
    '[aria-label][role="listitem"], [aria-label][role="article"]'
  ).forEach((el) => {
    // Dropped role="button" — too broad, picks up star ratings and nav buttons
    if (!isInViewport(el) || !isInMainContent(el)) return;
    const text = (el.getAttribute("aria-label") || "").trim();
    if (looksLikeProductName(text)) products.add(text);
  });

  // ── Strategy 4: Heuristic — headings inside product containers ────────────
  document.querySelectorAll(
    '[class*="product"], [class*="item-card"], [class*="ItemCard"], [class*="ProductCard"]'
  ).forEach((container) => {
    if (!isInViewport(container) || !isInMainContent(container)) return;
    const heading = container.querySelector("h1, h2, h3, h4");
    if (heading && isInViewport(heading)) {
      const text = heading.textContent.trim();
      if (looksLikeProductName(text) && !text.includes("\n")) products.add(text);
    }
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
