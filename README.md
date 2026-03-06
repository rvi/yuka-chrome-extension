# Yuka Product Scanner — Chrome Extension

Scan products on any ecommerce page and get their Yuka health scores instantly, right in a side panel.

## Features

- **Side Panel UI** — Opens alongside any page without interrupting your browsing
- **Auto-detect products** — Extracts product names from Amazon, Walmart, Target, Carrefour, Instacart, and most ecommerce sites using DOM selectors, JSON-LD structured data, and heuristics
- **Smart search** — If the full product label doesn't match, the extension automatically retries with shorter fallbacks (brand name, ALL-CAPS words, significant word pairs)
- **Yuka Score Lookup** — Searches each product in Yuka's database via Algolia and deduplicates results by product ID
- **Color-coded scores** — Instantly see product quality at a glance:
  - 🟢 **Excellent** (> 85) — Deep green
  - 🟢 **Good** (70 – 85) — Green
  - 🟠 **Mediocre** (30 – 70) — Orange
  - 🔴 **Bad** (0 – 30) — Red
- **Manual search** — Look up any product by name
- **Summary bar** — Overview of scanned products by score category


!(Example of the Yuka extension)[examples/amazon.png]

---

## Installation

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked** and select this folder
4. Click the extension icon — the side panel will open

---

## Authentication

### Why not email / password?

Yuka does not expose a public API or any OAuth flow for third-party clients. All of their app traffic goes through **Firebase Authentication** (for identity) and **Algolia** (for product search). There is no official developer programme, no API keys to request, and no documented endpoints.

Even if you wanted to authenticate with Firebase directly, you would need the app's own Firebase project credentials (embedded inside the iOS/Android binary), which is fragile, against Yuka's terms, and would still only give you a short-lived token (see below). The approach used here — capturing the **Algolia secured API key** that the app generates — is more practical, less brittle, and the key stays valid for around 20 days.

### How authentication actually works

When the Yuka mobile app starts a session, it performs two steps:

1. **Firebase login** — The app authenticates with Firebase using your email + password and receives a **Firebase ID token** (a signed JWT). This token expires after **1 hour**.

2. **Algolia key generation** — The app immediately exchanges that short-lived Firebase ID token for a long-lived **Algolia secured API key** by calling:
   ```
   GET https://goodtoucan.com/ALJPAW5/api/algolia/key/generate?token=<firebase_jwt>
   ```
   The server verifies the Firebase token, then returns an Algolia secured key that has your user identity, search filters (grades, countries, exclusions), and an expiry date embedded inside it as base64.

This extension skips step 1 entirely and asks you to paste the **Algolia secured key** directly. That key is all that is needed to query the product database.

---

## How to retrieve the Algolia API key

You need to intercept your Yuka app's HTTPS traffic using a proxy. The steps below use **mitmproxy** (free, cross-platform), but Charles Proxy or any HTTPS-capable proxy works the same way.

### 1. Set up the proxy on your computer

```bash
# Install mitmproxy
brew install mitmproxy        # macOS
# or: pip install mitmproxy

# Start it on port 9090
mitmproxy --listen-port 9090
```

### 2. Configure your iPhone / Android to use the proxy

- On **iPhone**: Settings → Wi-Fi → tap your network → Configure Proxy → Manual
  - Server: your computer's local IP (e.g. `192.168.1.10`)
  - Port: `9090`
- On **Android**: Settings → Wi-Fi → long-press your network → Modify → Advanced → Proxy → Manual (same values)

### 3. Install the mitmproxy CA certificate on your phone

Navigate to `http://mitm.it` in Safari/Chrome on your phone while the proxy is running. Download and install the certificate for your platform, then trust it:

- **iPhone**: 
	1. Settings → General → VPN & Device Management → install the certificate
	2. Settings → General → About → Certificate Trust Settings → enable full trust for the mitmproxy cert
- **Android**: Settings → Security → Install from storage

### 4. Capture the key from the Yuka app

Open the Yuka app and **scan or browse any product**. Back in your mitmproxy terminal, look for this request:

```
POST https://m8ujg2x7hl-dsn.algolia.net/1/indexes/prod_product/query
```

Select that request and inspect its **body**. You will see a JSON payload like:

```json
{
  "apiKey": "ALGOLIA-TOKEN",
  "params": "analytics=true&query=..."
}
```

**Copy the entire `apiKey` value** — that long base64 string is what you paste into the extension's login screen.

### 5. Paste it into the extension

Open the extension side panel, paste the key, and click **Connect**. The extension will validate it live against Algolia before saving it.

---

## Token validity

The Algolia secured API key is **valid for approximately 20 days** from the moment it was generated.

The key contains a `validUntil` field (a Unix timestamp) embedded in its base64 payload. You can inspect the exact expiry yourself:

```bash
# Decode the key to read the embedded parameters
echo "ALGOLIA-TOKEN" | base64 -d
# You will see: ...&validUntil=1773988873&...
```

Once the key expires you will start getting 403 errors. Simply re-capture a fresh key from the proxy (step 4 above) and paste it into the extension again — the whole process takes about two minutes.

---

> **Disclaimer:** This extension was vibe coded with [Claude](https://claude.ai). Use at your own risk.

---

## How the extension works

1. **Content script** (`content.js`) — Injected into every page, it scans the DOM for product names using CSS selectors (Amazon, Walmart, Target, Instacart…), JSON-LD structured data (`@type: Product`), and heuristic container detection.

2. **Smart search** (`sidepanel.js → buildSearchQueries`) — For each product name, the extension builds a ranked list of queries to try: full name first, then ALL-CAPS brand words (e.g. `NUTELLA` from `Pâte à Tartiner NUTELLA`), then shorter word pairs, down to a single significant word. It stops at the first query that returns results.

3. **Deduplication** — Results are deduplicated by Yuka product ID (`hashId`) so the same product appearing under different names on a page is only shown once.

4. **Background service worker** (`background.js`) — Handles all network requests (Algolia search) to avoid CORS issues, since service workers have cross-origin fetch access granted via `host_permissions` in the manifest.
