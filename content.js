// Content script: extracts product names from ecommerce pages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_PRODUCTS") {
    const products = extractProductNames();
    sendResponse({ success: true, products });
  }
  return true;
});

function extractProductNames() {
  const products = new Set();

  // Strategy 1: Common ecommerce selectors
  const selectors = [
    // Generic product selectors
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
    '[data-cy="title-recipe"] h2',
    '#productTitle',
    // Walmart
    '[data-automation-id="product-title"]',
    '.sans-serif.mid-gray',
    // Target
    '[data-test="product-title"]',
    'a[data-test="product-title"]',
    // Instacart
    '.e-1kk9uo0',
    '[data-testid="product_card_name"]',
    // Generic
    '.item-title',
    '.listing-title',
    'h2.product-name',
    'h3.product-name',
    '.card-title',
    // Schema.org
    '[itemprop="name"]',
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el) => {
      const text = (el.getAttribute('data-product-name') || el.textContent || "").trim();
      if (text && text.length > 2 && text.length < 200) {
        products.add(text);
      }
    });
  }

  // Strategy 2: Look for structured data (JSON-LD)
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  scripts.forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      extractFromJsonLd(data, products);
    } catch (e) {
      // ignore parse errors
    }
  });

  // Strategy 3: Heuristic - look for headings inside product-like containers
  const containerPatterns = /product|item|card|listing|result/i;
  const containers = document.querySelectorAll('[class*="product"], [class*="item"], [class*="card"], [class*="listing"]');
  containers.forEach((container) => {
    const heading = container.querySelector('h1, h2, h3, h4, a[href*="product"], a[href*="item"]');
    if (heading) {
      const text = heading.textContent.trim();
      if (text && text.length > 2 && text.length < 200 && !text.includes('\n')) {
        products.add(text);
      }
    }
  });

  return [...products].slice(0, 50); // Limit to 50 products
}

function extractFromJsonLd(data, products) {
  if (Array.isArray(data)) {
    data.forEach((item) => extractFromJsonLd(item, products));
    return;
  }

  if (data && typeof data === "object") {
    if (
      (data["@type"] === "Product" || data["@type"] === "ItemPage") &&
      data.name
    ) {
      products.add(data.name.trim());
    }

    // Check for itemListElement
    if (data.itemListElement) {
      data.itemListElement.forEach((item) => {
        if (item.item && item.item.name) {
          products.add(item.item.name.trim());
        }
        if (item.name) {
          products.add(item.name.trim());
        }
      });
    }
  }
}
