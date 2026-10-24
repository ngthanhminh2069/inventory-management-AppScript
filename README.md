# OpenWMS v2.0 - Serverless Warehouse, Lab Bench & Procurement Control

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-V8%20Runtime-34A853.svg)](https://developers.google.com/apps-script)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.x-38B2AC.svg)](https://tailwindcss.com/)
[![Release](https://img.shields.io/badge/Release-v2.0-indigo.svg)](https://github.com/ngthanhminh2069/inventory-management-AppScript)

**OpenWMS v2.0** is a lightweight, zero-cost warehouse, lab bench, and procurement control system running entirely on **Google Sheets** and **Google Apps Script V8** for small teams/companies who are still working, tracking with normal excel file.

Built for laboratories, biotechnology facilities, manufacturing workshops, and distribution centers, OpenWMS v2.0 delivers real-time stock control, FEFO lot picking, in-transit purchase order tracking, lab bench consumption monitoring, accounts payable (AP) invoice reconciliation, and an immutable audit trail without requiring external servers or database subscriptions.

---

## What's New in Version 2.0 🚀

- **In-Use Bench Inventory Management (`IN_USE`)**: Track opened containers, reagent bottles, and active packages on lab benches and shop floor workstations. Mark items as depleted when consumed.
- **Supplier Accounts Payable & Payment Ledger (`PAYMENTS`)**: Record vendor invoices, track payment status (`UNPAID`, `PARTIAL`, `PAID`), and enforce strict anti-overpayment guardrails.
- **Multi-Line Purchase Orders & Landed Obligations**: Support multi-item POs with separate accounting lines for freight, handling, and logistics fees (`FEE_LOGISTICS`).
- **Physical Storage Location Tagging**: Assign specific storage bins, cold rooms, or shelves to SKUs and lots, with automatic storage backfilling.
- **Bulk Initial Inventory Import**: Onboard hundreds of starting stock records in seconds using the built-in Excel template or direct clipboard paste.
- **Dynamic Header Mapping & Zero-Truncation**: Dynamically maps sheet headers and preserves leading zeros (e.g. `'000123'`) on lot numbers and SKU codes.
- **In-App Interactive SOP Documentation**: Clean, responsive, 8-module SOP manual embedded directly in the web app UI.

---

## Core Capabilities

- **Google Sheets as Single Source of Truth (SSOT)**: 100% transparent, auditable data stored in 6 relational sheets (`ITEMS`, `BATCHES`, `OPEN_POS`, `PAYMENTS`, `IN_USE`, `TRANSACTIONS`).
- **FEFO (First-Expired, First-Out) Engine**: Automatic lot sorting, visual expiry status badges (Safe, Near-Expiry, Expired), and priority picking.
- **7-State Reorder Disambiguation Tree**: Eliminates phantom inventory by evaluating replenishment strictly against usable on-hand stock ($D > 0$).
- **Anti-Over-Receipt & Temporal Consistency**: Prevents dock operators from over-receiving beyond open PO quotas and enforces chronological reality.
- **Auditable Void Engine**: Physical row deletion is forbidden; errors are corrected via atomic compensating reversal entries (`VOID_IN`, `VOID_OUT`).
- **Concurrency Protection**: Google `LockService` serialization with atomic sheet flushes prevents multi-user race conditions.

---

## Directory Structure

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md               # GitHub bug report template
│   │   └── feature_request.md          # GitHub feature request template
│   └── workflows/
│       └── clasp-push.yml.example      # CI/CD deployment via Clasp
├── docs/
│   ├── SOP_USER_MANUAL.md              # 8-Module Standard Operating Procedures
│   ├── DATABASE_SCHEMA.md              # 6 Sheet schemas, field types & ER diagram
│   └── ARCHITECTURE.md                 # 3-Tier stock, AP engine & LockService design
├── src/
│   ├── Code.js                         # Upgraded Apps Script backend engine
│   └── Index.html                      # Upgraded Tailwind CSS single-page app
├── .gitignore                          # Prevents credential & system file leakage
├── appsscript.json                     # Apps Script V8 manifest
├── LICENSE                             # MIT License
└── README.md                           # Documentation & quickstart guide
```

---

## Quickstart Guide

### Option A: Standard Deployment (No Coding Required)

1. **Create a Google Spreadsheet**:
   - Go to [Google Sheets](https://sheets.new) and create a new blank spreadsheet.
   - Name your sheet (e.g., `OpenWMS - Inventory & Procurement Control`).
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
   - Open the Web App URL on any browser, tablet, or phone to begin managing inventory! The 6 database sheets (`ITEMS`, `BATCHES`, `OPEN_POS`, `PAYMENTS`, `IN_USE`, `TRANSACTIONS`) will be created automatically on first load.

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
   git clone https://github.com/ngthanhminh2069/inventory-management-AppScript.git
   cd inventory-management-AppScript
   ```
4. **Create or Link Project**:
   ```bash
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
  APP_TITLE: 'OpenWMS - Smart Inventory & Payment Control',
  TIMEZONE: 'GMT+7',                    // Warehouse local timezone
  DATE_FORMAT: 'yyyy-MM-dd',            // Standard date formatting
  DATETIME_FORMAT: 'yyyy-MM-dd HH:mm:ss',
  NEAR_EXPIRY_DAYS: 30,                 // Days threshold for amber warning
  DEFAULT_OPERATOR: 'demo.user@example.com'
};
```

---

## Technical Documentation

- [Standard Operating Procedures (SOP)](docs/SOP_USER_MANUAL.md) - Complete 8-module manual covering In-Use bench lifecycle, accounts payable, FEFO lot picking, and void rules.
- [Database Schema & Data Flow](docs/DATABASE_SCHEMA.md) - Field specifications for all 6 sheets, data types, constraints, and relational ER diagram.
- [System Architecture](docs/ARCHITECTURE.md) - Deep dive into 3-Tier Stock Classification, AP FIFO allocation, and LockService ACID compliance.

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
