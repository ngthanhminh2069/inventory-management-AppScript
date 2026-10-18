# OpenWMS - Serverless Inventory & Warehouse Control

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-V8%20Runtime-34A853.svg)](https://developers.google.com/apps-script)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.x-38B2AC.svg)](https://tailwindcss.com/)
[![Code Style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)

**OpenWMS** is a lightweight, zero-cost, enterprise-grade warehouse and inventory management system running entirely on **Google Sheets** and **Google Apps Script**. It provides real-time stock control, First-Expired, First-Out (FEFO) lot tracking, in-transit purchase order monitoring, anti-over-receipt guardrails, and an immutable audit trail without requiring external servers or database hosting.

---

## Key Features

- **Google Sheets as Single Source of Truth (SSOT)**: Fully transparent, accessible, and queryable data stored directly in your Google Drive.
- **FEFO (First-Expired, First-Out) Engine**: Automatic lot sorting, expiry status badges (Safe, Near-Expiry, Expired), and priority picking.
- **In-Transit PO Tracker**: Calculate Effective Stock ($\text{Effective Stock} = \text{Usable On-Hand} + \text{In-Transit Qty}$) with strict 0% tolerance anti-over-receipt guardrails.
- **7-State Reorder Disambiguation**: Deterministic safety stock alerting that eliminates phantom inventory caused by expired goods.
- **Temporal Consistency Verification**: Prevents logging outbound shipments prior to the earliest historical lot receipt date.
- **Auditable Void Engine**: Immutable historical ledger where row deletion is forbidden; errors are corrected via atomic compensating reversal entries (`VOID_IN`, `VOID_OUT`).
- **Concurrency Protection**: Multi-user race condition prevention using Google `LockService` and atomic sheet flushes.
- **Export & Reporting**: Built-in Excel/CSV export powered by SheetJS and visual KPI analytics via Chart.js.

---

## Directory Structure

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── workflows/
│       └── clasp-push.yml.example
├── docs/
│   ├── SOP_USER_MANUAL.md          <-- Standard Operating Procedures & business rules
│   ├── DATABASE_SCHEMA.md          <-- 4 sheet schemas, field types & ER diagram
│   └── ARCHITECTURE.md             <-- SSOT, LockService, & client-server RPC bridge
├── src/
│   ├── Code.js                     <-- Backend Apps Script engine & business logic
│   └── Index.html                  <-- Tailwind CSS single-page dashboard UI
├── .gitignore                      <-- Prevents clasp credentials & system file leakage
├── appsscript.json                 <-- Apps Script V8 project manifest
├── LICENSE                         <-- MIT License
└── README.md                       <-- Project documentation & quickstart
```

---

## Quickstart Guide

### Option A: Standard Deployment (No Coding Required)

1. **Create a Google Spreadsheet**:
   - Go to [Google Sheets](https://sheets.new) and create a new blank spreadsheet.
   - Name your sheet (e.g., `OpenWMS - Inventory Control`).
2. **Open the Apps Script Editor**:
   - In the spreadsheet menu, click **Extensions** $\rightarrow$ **Apps Script**.
3. **Copy Source Code**:
   - Copy the contents of [`src/Code.js`](src/Code.js) into `Code.gs` in the editor.
   - Click the **+** icon beside **Files** $\rightarrow$ select **HTML** $\rightarrow$ name it `Index` (producing `Index.html`).
   - Copy the contents of [`src/Index.html`](src/Index.html) into this new file.
4. **Configure Project Manifest**:
   - In the left sidebar, click **Project Settings** (gear icon) $\rightarrow$ check **Show "appsscript.json" manifest file in editor**.
   - Switch back to the editor, open `appsscript.json`, and replace its content with the contents of [`appsscript.json`](appsscript.json).
5. **Deploy as Web App**:
   - Click **Deploy** $\rightarrow$ **New deployment**.
   - Select type: **Web app**.
   - **Execute as**: `Me` (your Google account).
   - **Who has access**: `Anyone` (or `Anyone within your organization`).
   - Click **Deploy**, authorize permissions, and copy the published Web App URL.
6. **Launch OpenWMS**:
   - Open the Web App URL on any browser, tablet, or phone to begin managing inventory! The 4 database sheets (`ITEMS`, `BATCHES`, `OPEN_POS`, `TRANSACTIONS`) will be created automatically on first load.

---

### Option B: Developer Setup via Google Clasp (Command Line)

1. **Install Clasp**:
   ```bash
   npm install -g @google/clasp
   ```
2. **Log In to Google**:
   ```bash
   clasp login
   ```
3. **Clone this Repository**:
   ```bash
   git clone https://github.com/<YOUR_USERNAME>/open-inventory-control.git
   cd open-inventory-control
   ```
4. **Create or Link Project**:
   ```bash
   # Create a new spreadsheet-bound script
   clasp create --title "OpenWMS" --type sheets --rootDir ./src
   ```
5. **Push Code & Open**:
   ```bash
   clasp push
   clasp open
   ```

---

## Configuration (`src/Code.js`)

Central configuration parameters are defined in `APP_CONFIG`:

```javascript
const APP_CONFIG = {
  APP_TITLE: 'OpenWMS - Smart Inventory Control',
  TIMEZONE: 'GMT+7',                    // Warehouse local timezone
  DATE_FORMAT: 'yyyy-MM-dd',            // Standard date formatting
  DATETIME_FORMAT: 'yyyy-MM-dd HH:mm:ss',
  NEAR_EXPIRY_DAYS: 30,                 // Days threshold for amber warning
  DEFAULT_OPERATOR: 'demo.user@example.com'
};
```

---

## Documentation

- [Standard Operating Procedures (SOP)](docs/SOP_USER_MANUAL.md) - Complete operational manual, lot grading rules, and receipt guardrails.
- [Database Schema & Data Flow](docs/DATABASE_SCHEMA.md) - Field specifications, primary keys, relationships, and sequence diagrams.
- [System Architecture](docs/ARCHITECTURE.md) - Deep dive into SSOT design, LockService ACID compliance, and Google Apps Script RPC.

---

## Contributing

Contributions are warmly welcome! Please feel free to open a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) or submit a [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for more details.
