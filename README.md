# Yuka Product Scanner - Chrome Extension

Scan products on any ecommerce page and get their Yuka health scores instantly.

## Features

- **Side Panel UI** — Opens as a side panel for easy access while browsing
- **Auto-detect products** — Extracts product names from Amazon, Walmart, Target, and other ecommerce sites
- **Yuka Score Lookup** — Searches each product in Yuka's database via Algolia
- **Color-coded scores** — Instantly see product quality:
  - 🟢 **Excellent** (>85): Deep green
  - 🟢 **Good** (70–85): Green
  - 🟠 **Mediocre** (30–70): Orange
  - 🔴 **Bad** (0–30): Red
- **Manual search** — Look up any product by name
- **Summary dashboard** — Overview of scanned products by score category

## Setup

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Click the extension icon to open the side panel

## Authentication

You need a Yuka authentication token (Firebase JWT) to use this extension. Paste it in the login screen to connect.

## How It Works

1. The content script scans the current page for product names using DOM selectors, JSON-LD structured data, and heuristics
2. Each product name is searched against Yuka's Algolia index
3. Results display the Yuka grade with color coding and brand info
