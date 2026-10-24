# OpenWMS v2.0 - Standard Operating Procedures (SOP) & User Manual

## 1. Overview & Operational Philosophy
**OpenWMS v2.0** is an open-source, serverless warehouse, lab bench, and procurement control system built on top of **Google Sheets** (Single Source of Truth) and **Google Apps Script V8**.

Version 2.0 expands the system from bulk inventory management into a complete operational suite incorporating **In-Use Bench Inventory**, **Supplier Accounts Payable (AP)**, **Multi-Line Purchase Orders with Landed Logistics Obligations**, and **Bulk Onboarding**.

---

## 2. Core Business Modules & Operating Rules

### 2.1. Master SKU Catalog & Storage Locations (`ITEMS` Sheet)
The Master SKU catalog maintains authoritative definitions and physical storage assignments for every item.
- **Unique Identifier**: `ItemCode` (SKU). Automatically formatted to uppercase (e.g., `REAG-POLY-01`, `PKG-BOX-L`).
- **Physical Storage Location (`Storage`)**: Defines default bin, rack, or cold-room storage (e.g., `Cold Room A - Shelf 2`, `Aisle 3 - Rack B`).
- **Safety Stock / Reorder Point (`MinStock`)**:
  - **$\text{MinStock} > 0$**: Active inventory monitoring. Triggers automated stockout warnings when usable on-hand stock drops to or below threshold.
  - **$\text{MinStock} = 0$**: Bypasses stockout alerting (for consumables or ad-hoc supplies).
- **Usable vs. Expired Stock Segregation**:
  - Safety stock comparisons are strictly evaluated against **Usable On-Hand Inventory** ($I_{WH}^{\text{usable}}$). Expired stock ($D \le 0$) is segregated to prevent **phantom inventory** from concealing real stockouts.

---

### 2.2. Multi-Line In-Transit PO Tracker & Landed Obligations (`OPEN_POS` Sheet)
Tracks goods ordered from suppliers before physical dock arrival, alongside associated logistics expenses.

#### Total Order Value & Landed Obligations
$$\text{Total PO Amount} = \sum_{j \in \text{Items}} \text{GoodsAmount}_j + \text{DeliveryFee} + \text{HandlingFee} + \text{OtherFees}$$
- **Physical Pipeline ($I_{IT}$)**:
  $$I_{IT, i} = \sum_{p \in P_i^{\text{Active}}, \text{LineType} = \text{'ITEM'}} (\text{QtyOrdered}_p - \text{QtyReceived}_p)$$
  *Note*: Logistics fee lines (`FEE_LOGISTICS`) have $\text{LineType} = \text{'FEE'}$ and contribute **0 units** to physical inventory. They represent financial payment obligations to match vendor invoices.
- **Effective Stock Formula**:
  $$\text{Effective Stock} = \text{Usable Physical On-Hand} + \text{In-Transit Quantity}$$
- **Multi-Line Cancellation Rule**:
  Cancelling an open PO cancels **all line items and fee records** associated with that `PoNumber`. Cancellation is permitted only if **no receipts** ($\text{QtyReceived} = 0$) and **no payments** ($\text{PaidAmount} = 0$) have occurred.

---

### 2.3. FEFO Lot System & Expiry Tracking (`BATCHES` Sheet)
Enforces **First-Expired, First-Out (FEFO)** picking for perishable and dated goods.

- **Composite Key**: `BatchKey = ItemCode_LotNumber`.
- **Text Strict Formatting**: Numeric lot numbers (e.g., `000123`, `089`) are prefixed with `'` to preserve leading zeros in Google Sheets.
- **Expiry Classification Windows**:
  Let $D$ be calendar days to expiration:
  $$D = \left\lceil \frac{\text{truncateToMidnight}(T_{\text{exp}}, \text{tz}) - \text{truncateToMidnight}(T_{\text{today}}, \text{tz})}{86400000} \right\rceil$$

| Status Badge | Expiry Window | UI Indicator | Action Required |
| :--- | :--- | :--- | :--- |
| **Expired** | $D \le 0$ days | <span style="color:#991b1b;background:#fee2e2;padding:2px 6px;border-radius:4px;">Expired</span> | **Outbound blocked.** Quarantined for scrap. |
| **Near-Expiry** | $0 < D \le 30$ days | <span style="color:#92400e;background:#fef3c7;padding:2px 6px;border-radius:4px;">Near-Expiry</span> | **Priority picking.** System prioritizes for dispatch. |
| **Safe** | $D > 30$ days | <span style="color:#166534;background:#dcfce7;padding:2px 6px;border-radius:4px;">Safe</span> | Normal operational stock. |
| **None** | Undated / N/A | <span style="color:#475569;background:#f1f5f9;padding:2px 6px;border-radius:4px;">None</span> | Non-perishable hardware/supplies. |

#### Reorder Disambiguation Tree (7 Non-Overlapping States)
1. **`STOCKOUT`**: $I_{WH}^{\text{usable}} = 0 \land I_{IT} = 0$ (Urgent: Stockout, no PO placed).
2. **`STOCKOUT_IN_TRANSIT`**: $I_{WH}^{\text{usable}} = 0 \land I_{\text{eff}} \ge \text{MinStock}$ (Depleted in warehouse, but PO covers demand).
3. **`STOCKOUT_PARTIAL_TRANSIT`**: $I_{WH}^{\text{usable}} = 0 \land 0 < I_{\text{eff}} < \text{MinStock}$ (Depleted in warehouse, PO insufficient).
4. **`LOW_STOCK`**: $0 < I_{WH}^{\text{usable}} \le \text{MinStock} \land I_{IT} = 0$ (Below threshold, immediate PO required).
5. **`IN_TRANSIT_COVERED`**: $0 < I_{WH}^{\text{usable}} \le \text{MinStock} \land I_{\text{eff}} \ge \text{MinStock}$ (Below threshold, pending PO replenishes to safety level).
6. **`IN_TRANSIT_PARTIAL`**: $0 < I_{WH}^{\text{usable}} \le \text{MinStock} \land I_{\text{eff}} < \text{MinStock}$ (Below threshold, pending PO insufficient).
7. **`OPTIMAL`**: $I_{WH}^{\text{usable}} > \text{MinStock}$ (Healthy inventory).

---

### 2.4. In-Use Bench Management (`IN_USE` Sheet)
Tracks opened reagents, bottles, and packages actively being consumed on laboratory benches or production stations.

- **Bench Stock Isolation**:
  $$I_{\text{bench}, i} = \sum_{u \in U_i^{\text{Active}}} \text{Qty}_u \quad (\text{Status} = \text{'IN\_USE'})$$
  *Crucial Rule*: Items moved to the bench are considered **consumed from bulk warehouse stock** ($\text{QtyOut}$ is logged in `BATCHES`). They do not satisfy warehouse $\text{MinStock}$ replenishment requirements.
- **Depletion Lifecycle**:
  - When technicians finish an opened bottle, they click **Mark Depleted**.
  - Status updates to `DEPLETED` with timestamp and user attribution.
- **Anti-Phantom Reversal Guard**:
  An Outbound transaction that opened a bench item **cannot be voided** if that item has already been marked as `DEPLETED`. This prevents phantom inventory from being resurrected into bulk stock.

---

### 2.5. Accounts Payable & Supplier Payments (`PAYMENTS` Sheet)
Manages supplier invoices and records disbursements against PO balances.

#### Anti-Overpayment Guardrail (0% Tolerance)
When logging a payment $A_{\text{paid}}$ against PO $k$:
$$A_{\text{paid}} \le \text{RemainingPayable}_k + 0.0001$$
where:
$$\text{RemainingPayable}_k = \sum_{r \in \text{Lines}_k} (\text{TotalAmount}_r - \text{PaidAmount}_r)$$
- Payments exceeding the remaining payable balance trigger an immediate hard stop.
- Payments against `CANCELLED` POs are strictly rejected.
- Payments are automatically allocated across line items using sequential FIFO allocation.
- **Payment Lifecycle**: `UNPAID` $\rightarrow$ `PARTIAL` $\rightarrow$ `PAID`.
- **Payment Voiding**: Voiding a payment decrements `PaidAmount` in reverse order and rolls back the PO status.

---

### 2.6. Temporal & Over-Receipt Guardrails
- **Anti-Over-Receipt Enforcement**:
  $$\text{QtyIn} \le \text{QtyOrdered} - \text{QtyReceived}$$
  Transactions attempting to fulfill more than the open PO balance are rejected.
- **Temporal Consistency**:
  $$T_{\text{dispatch}}(\text{Lot}) \ge \min \{ T_{\text{inbound}}(\text{Lot}) \}$$
  Outbound dispatch cannot be backdated prior to the earliest recorded physical receipt of that specific lot.

---

### 2.7. Auditable Void Engine (`TRANSACTIONS` Sheet)
- **Immutable Ledger**: Physical row deletion is prohibited.
- **Idempotency Guard**: Double-voiding or voiding reversal entries is blocked.
- **Compensating Records**: Voiding an `IN` creates `VOID_IN`; voiding an `OUT` creates `VOID_OUT`. Original row status becomes `VOIDED`.
- **Pre-Void Feasibility**:
  $$\text{CurrentStock}_{\text{batch}} \ge \text{Qty}_{\text{void}}$$
  Prevents voiding inbound deliveries if goods were already consumed downstream.
- **PO Rollback**: Voiding an Inbound transaction restores open PO balances:
  $$\text{RECEIVED} \rightarrow \text{PARTIAL} \rightarrow \text{OPEN}$$

---

### 2.8. Bulk Initial Inventory Import
Provides fast onboarding of existing physical stock:
- **Excel & Clipboard Paste**: Download the pre-formatted Excel template (`.xlsx`) or paste tab-separated rows directly.
- **Batch Writing (1-2 API Calls)**: Processes hundreds of records simultaneously in memory before committing, avoiding Google Apps Script execution timeouts.
- **Text Preservation**: Strict column formatting preserves leading zeros on lot numbers and item codes.

---

## 3. Operational Step-by-Step Procedures

### 3.1. Setting Up Master SKUs with Storage Locations
1. Go to the **Master SKU** tab in the sidebar.
2. Click **+ Add New SKU**.
3. Fill in `Item Code`, `Item Name`, `Category`, `Unit`, `Min Stock`, and `Storage Location` (e.g., `Bin B-14`).
4. Click **Save SKU**.

### 3.2. Creating a Multi-Line Purchase Order with Logistics Fees
1. Go to the **In-Transit POs** tab and click **+ Log In-Transit PO**.
2. Enter the `PO Number`, `Vendor Name`, `Currency`, `Payment Terms`, and expected `ETA`.
3. Add item lines by selecting the SKU, quantity, and total line price. Click **+ Add Another Item** for additional lines.
4. If the vendor charges freight or handling, enter the amounts under `Delivery Fee` or `Handling Fee`.
5. Review the calculated order total and click **Confirm PO**.

### 3.3. Receiving Inbound Deliveries at Dock
1. Click **Inbound (IN)** on the dashboard or top action bar.
2. Select the SKU and link the open PO from the dropdown.
3. Enter the `Lot Number` and `Expiration Date`.
4. Enter the `Received Quantity` (system validates against open PO balance).
5. Click **Confirm Inbound**. The lot balance and PO fulfillment status update in real time.

### 3.4. Dispatching to Lab Bench (Opening In-Use Item)
1. Click **Outbound (OUT)**.
2. Select the target SKU and select the lot according to FEFO priority.
3. Enter the quantity to dispatch.
4. Check the box **"Mark In-Use on Bench"**.
5. Optionally select an existing bench container to mark as replaced.
6. Click **Confirm Outbound**. A new tracking card appears in the **Stock & Batches $\rightarrow$ In-Use on Bench** view.

### 3.5. Depleting a Bench Container
1. Open the **Stock & Batches** tab and switch to **In-Use on Bench**.
2. Locate the finished item card.
3. Click **Mark Depleted** and enter any notes (e.g., `Consumed during Assay Run #4`).
4. The container is archived as `DEPLETED`.

### 3.6. Logging Supplier Invoices & Payments
1. Go to the **Payments & AP** tab.
2. Locate the PO and click **Log Payment**.
3. Enter the `Invoice Number`, `Payment Date`, `Amount Paid`, and optional link to receipt/invoice PDF.
4. Click **Confirm Payment**. The payment is recorded in `PAYMENTS` and allocated across the PO lines.

### 3.7. Bulk Importing Starting Stock
1. Go to the **Stock & Batches** tab.
2. Click **Bulk Initial Stock**.
3. Download the Excel template, fill in your warehouse counts, and upload the file (or paste rows into the text area).
4. Review the auto-validated rows and click **Submit Bulk Inventory**.
