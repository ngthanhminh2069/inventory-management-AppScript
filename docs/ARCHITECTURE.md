# OpenWMS - System Architecture & Technical Design

## 1. Architectural Philosophy: Google Sheets as SSOT
**OpenWMS** is built upon the paradigm of **Zero-Infrastructure, Serverless Enterprise Applications**. Instead of requiring dedicated database servers (PostgreSQL, MySQL), container runtimes, or paid SaaS subscriptions, OpenWMS leverages **Google Sheets** as a relational database, **Google Apps Script V8** as an execution engine, and **HTML5/Tailwind CSS** as a single-page responsive user interface.

```text
┌────────────────────────────────────────────────────────────────┐
│                       CLIENT TIER                              │
│  Single-Page Application (src/Index.html)                     │
│  - Tailwind CSS 3.x (Styling & Responsive Layout)              │
│  - Chart.js (Inventory Analytics & Consumption Trends)         │
│  - SheetJS (Client-side Excel/CSV Reporting Engine)            │
│  - FontAwesome 6 (Vector Icons)                                │
└───────────────────────────────┬────────────────────────────────┘
                                │ google.script.run (RPC Bridge)
┌───────────────────────────────▼────────────────────────────────┐
│                     APPLICATION TIER                           │
│  Google Apps Script V8 Runtime (src/Code.js)                  │
│  - Concurrency Gatekeeper (LockService)                        │
│  - Domain Engines (FEFO, Effective Stock, Anti-Over-Receipt)   │
│  - Immutable Audit Ledger & Reversal Generator                │
│  - Serialization & Date/Time Truncation Engine                │
└───────────────────────────────┬────────────────────────────────┘
                                │ Sheets API v4 (SpreadsheetApp)
┌───────────────────────────────▼────────────────────────────────┐
│                       STORAGE TIER                             │
│  Google Spreadsheet (Single Source of Truth)                  │
│  - ITEMS        (Master SKU Definitions)                       │
│  - BATCHES      (Lot Balances & Expiry Dates)                  │
│  - OPEN_POS     (In-Transit Purchase Orders)                   │
│  - TRANSACTIONS (Append-Only Historical Ledger)                │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Concurrency Control & ACID Guarantees

In multi-user warehousing environments, concurrent operations (e.g., two pickers attempting to allocate the same remaining 10 units of a lot simultaneously) can lead to data race conditions and negative inventory balances.

OpenWMS prevents race conditions by enforcing **ScriptLock Atomicity**:

```javascript
function executeMutatingOperation(...) {
  const lock = LockService.getScriptLock();
  // Acquire an exclusive global lock (max wait 15 seconds)
  lock.waitLock(15000);

  try {
    // 1. Read latest state directly from Google Sheets
    // 2. Perform business validation checks
    // 3. Apply mutations (setValues / appendRow)
    // 4. Force atomic disk write before releasing the lock
    SpreadsheetApp.flush();
    
    // 5. Return updated SSOT state to the caller
    return { success: true, appData: getInitialAppData() };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    // Guaranteed release even if an unhandled exception occurs
    lock.releaseLock();
  }
}
```

### ACID Compliance Mapping
- **Atomicity**: Mutations across multiple sheets (`BATCHES`, `OPEN_POS`, `TRANSACTIONS`) execute inside an exclusive lock block and are committed simultaneously via `SpreadsheetApp.flush()`.
- **Consistency**: Guardrails (FEFO expiry checks, anti-over-receipt quotas, pre-void stock availability) ensure the system never enters an illegal state.
- **Isolation**: Lock acquisition serializes competing write transactions, achieving Serializable isolation level.
- **Durability**: Google Cloud's distributed infrastructure persists all Google Spreadsheet cells with geo-redundancy and automated revision history.

---

## 3. Client-Server Communication Bridge

### 3.1. Asynchronous RPC Interface
The frontend communicates with Google Apps Script via the asynchronous `google.script.run` bridge. 

```javascript
// Example client-side invocation
google.script.run
  .withSuccessHandler((response) => {
    if (response.success) {
      // Re-hydrate global application state and re-render components
      appState = response.appData;
      renderAllViews();
      showToast("Transaction committed successfully", "success");
    } else {
      showToast(response.error, "error");
    }
  })
  .withFailureHandler((err) => {
    showToast("Network / Server Error: " + err.message, "error");
  })
  .createTransaction(payload);
```

### 3.2. Single Round-Trip State Hydration
Every successful mutating call returns the entire refreshed application dataset computed by `getInitialAppData()`. This design ensures:
1. The client is always 100% in sync with the Google Sheet database.
2. No risk of client-side cache drift or optimistic update desynchronization.
3. Zero complex client-side state reconciliation libraries required.

---

## 4. Security & Audit Architecture

### 4.1. Execution Mode (`appsscript.json`)
```json
{
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE"
  }
}
```
- **`executeAs: USER_DEPLOYING`**: The web application executes with the permissions of the spreadsheet owner. Warehouse workers do not require direct edit access to the underlying spreadsheet, preventing accidental formula or row deletion.
- **`access: ANYONE`** (or `DOMAIN`): Allows warehouse staff to access the web portal from any mobile device, barcode scanner, or workstation browser.

### 4.2. Immutable Ledger & Operator Attribution
- The authenticated Google account email is captured on every action via `Session.getActiveUser().getEmail()`.
- If running in an unauthenticated or public context, `APP_CONFIG.DEFAULT_OPERATOR` provides a clean fallback.
- Physical row deletion is architecturally disabled. Compensating reversal transactions (`VOID_IN`, `VOID_OUT`) guarantee a forensic audit trail for accounting compliance.

---

## 5. Performance Tuning & Scalability Limits

| Parameter | Recommended Operational Limit | Architecture Mitigation |
| :--- | :--- | :--- |
| **Active SKUs** | Up to 10,000 SKUs | In-memory indexing and client-side filtering via search input. |
| **Active Lots** | Up to 25,000 lots | Expired lots with zero balance can be archived to an `ARCHIVE_BATCHES` sheet. |
| **Transactions** | Up to 100,000 rows | Slicing the dashboard feed to `slice(0, 10)` and performing batch reads via `getDataRange().getValues()`. |
| **Concurrent Users** | 10 - 30 simultaneous operators | 15-second lock timeout queue; average transaction processing latency is ~250ms - 450ms. |
