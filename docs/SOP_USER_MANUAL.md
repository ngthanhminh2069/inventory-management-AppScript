# OpenWMS - Standard Operating Procedures (SOP) & User Manual

## 1. Overview & System Purpose
**OpenWMS** is an open-source, serverless warehouse and inventory management system designed to operate directly on top of Google Sheets (as the Single Source of Truth) and Google Apps Script V8. 

This manual establishes the mandatory operational rules, inventory accounting standards, and validation guardrails required for warehouse staff, storekeepers, and procurement teams.

---

## 2. Core Business Workflows & Operating Rules

### 2.1. Master SKU Management (`ITEMS` Sheet)
The Master SKU catalog maintains the authoritative list of tracked inventory items.
- **Unique Identifier**: `ItemCode` (Stock Keeping Unit / SKU). Case-insensitive, automatically converted to uppercase (e.g., `RAW-FLOUR-01`, `PKG-BOX-M`).
- **Required Metadata**: `ItemName`, `Category`, `Unit` of measure (e.g., `KG`, `PCS`, `BAG`, `BOX`).
- **Safety Stock / Reorder Point (`MinStock`)**:
  - Defines the minimum usable inventory level before a reorder alert is triggered.
  - **Threshold Rules**:
    - **$\text{MinStock} > 0$**: Active inventory monitoring. The dashboard will trigger warning badges and replenishment cards when usable on-hand inventory drops to or below this threshold.
    - **$\text{MinStock} = 0$**: Stockout alerting is bypassed (suitable for non-critical supplies, office consumables, or discontinued items).
- **Usable vs. Expired Stock Distinction**:
  - Safety stock evaluations are calculated strictly against **Usable On-Hand Inventory** ($I_{OH}^{\text{usable}}$). Expired inventory ($D \le 0$) is segregated and excluded to prevent **phantom inventory** from masking stockouts.

---

### 2.2. In-Transit Purchase Order Tracker (`OPEN_POS` Sheet)
Provides inbound pipeline visibility, enabling purchasing teams to track orders placed with suppliers prior to physical warehouse arrival.

#### Formula: Effective Stock
$$\text{Effective Stock} = \text{Usable Physical On-Hand} + \text{In-Transit Quantity}$$
where:
$$\text{In-Transit Quantity} = \sum_{p \in P_{\text{Active}}} (\text{QtyOrdered}_p - \text{QtyReceived}_p)$$

#### PO Lifecycle & State Transitions
- **`OPEN`**: Order logged with supplier; zero units physically received.
- **`PARTIAL`**: Partial quantity received at the dock ($0 < \text{QtyReceived} < \text{QtyOrdered}$).
- **`RECEIVED`**: Order fully fulfilled ($\text{QtyReceived} \ge \text{QtyOrdered}$).
- **`CANCELLED`**: Order aborted prior to receipt. Cannot be fulfilled.

#### Anti-Over-Receipt Guardrail (Zero Tolerance)
When receiving an inbound shipment against an open PO:
$$\text{QtyIn} \le \text{QtyOrdered} - \text{QtyReceived}$$
- If a warehouse operator attempts to receive more than the remaining PO balance, the transaction is **blocked immediately** with an explicit error:
  `Over-receipt Violation: PO [PO-XXXX] only has X units remaining...`
- Over-shipments must either be authorized via a new PO or logged as a non-PO direct inbound transaction.

---

### 2.3. FEFO Lot System & Expiry Tracking (`BATCHES` Sheet)
Implements **First-Expired, First-Out (FEFO)** to prevent inventory obsolescence and ensure perishable product quality.

#### Batch Identification
- Each unique lot is keyed by a composite key: `BatchKey = ItemCode_LotNumber`.
- If an existing lot is received again, the incoming expiry date must match the recorded expiry date. Conflicting dates for the same lot number are strictly prohibited.

#### Expiry Classification Windows
Let $D$ be the integer number of calendar days remaining until expiration:
$$D = \left\lceil \frac{\text{truncateToMidnight}(T_{\text{exp}}, \text{tz}) - \text{truncateToMidnight}(T_{\text{today}}, \text{tz})}{86400000} \right\rceil$$

| Status Badge | Expiry Condition | Visual Badge | Operational Protocol |
| :--- | :--- | :--- | :--- |
| **Expired** | $D \le 0$ days | <span style="color:#991b1b;background:#fee2e2;padding:2px 6px;border-radius:4px;">Expired</span> | **Outbound blocked.** Cannot be fulfilled for orders. Must be quarantined or scrapped. |
| **Near-Expiry** | $0 < D \le 30$ days | <span style="color:#92400e;background:#fef3c7;padding:2px 6px;border-radius:4px;">Near-Expiry</span> | **Priority picking.** System prioritizes this lot for immediate dispatch. |
| **Safe** | $D > 30$ days | <span style="color:#166534;background:#dcfce7;padding:2px 6px;border-radius:4px;">Safe</span> | Normal operating status. |
| **Non-perishable** | Undated / N/A | <span style="color:#475569;background:#f1f5f9;padding:2px 6px;border-radius:4px;">None</span> | No expiration tracking (durable consumables). |

#### Reorder Alert Disambiguation Tree
When $\text{MinStock} > 0$ and $I_{OH}^{\text{usable}} \le \text{MinStock}$, the alert status is evaluated via the following deterministic, mutually exclusive states:
1. **`STOCKOUT`**: $I_{OH}^{\text{usable}} = 0 \land I_{IT} = 0$ (Critical: Zero stock and no PO in pipeline).
2. **`STOCKOUT_IN_TRANSIT`**: $I_{OH}^{\text{usable}} = 0 \land I_{\text{eff}} \ge \text{MinStock}$ (Depleted on-hand, but open POs fully cover requirement).
3. **`STOCKOUT_PARTIAL_TRANSIT`**: $I_{OH}^{\text{usable}} = 0 \land 0 < I_{\text{eff}} < \text{MinStock}$ (Depleted on-hand, PO in pipeline is insufficient).
4. **`LOW_STOCK`**: $0 < I_{OH}^{\text{usable}} \le \text{MinStock} \land I_{IT} = 0$ (Below threshold, urgent PO required).
5. **`IN_TRANSIT_COVERED`**: $0 < I_{OH}^{\text{usable}} \le \text{MinStock} \land I_{\text{eff}} \ge \text{MinStock}$ (Below threshold, pending POs restore safety level).
6. **`IN_TRANSIT_PARTIAL`**: $0 < I_{OH}^{\text{usable}} \le \text{MinStock} \land I_{\text{eff}} < \text{MinStock}$ (Below threshold, pending POs insufficient).
7. **`OPTIMAL`**: $I_{OH}^{\text{usable}} > \text{MinStock}$ (Healthy inventory).

---

### 2.4. Temporal Consistency Guardrail
In physical warehouse logistics, goods cannot be dispatched before they physically arrive.
$$T_{\text{dispatch}}(\text{Lot}) \ge \min \{ T_{\text{inbound}}(\text{Lot}) \}$$
- When logging an outbound transaction (`OUT`), the user-selected dispatch date is validated against the earliest historical inbound arrival of that specific `LotNumber`.
- If an operator accidentally selects an outbound date prior to the receipt date, the transaction is rejected:
  `Temporal Conflict: Cannot dispatch on [YYYY-MM-DD]. Lot [LOT-X] was first received on [YYYY-MM-DD].`

---

### 2.5. Auditable Void Engine (`TRANSACTIONS` Sheet)
Maintains an immutable historical audit ledger.
- **Strict Prohibition of Row Deletion**: No rows in the `TRANSACTIONS` sheet are ever physically deleted.
- **Double-Void Idempotency Guard**:
  - Giao dịch đã có trạng thái `VOIDED` hoặc thuộc loại bút toán đảo `VOID_*` sẽ bị từ chối nếu có lệnh void tiếp theo.
- **Compensating Reversal Entries**:
  - Voiding an Inbound (`IN`) creates a compensating `VOID_IN` entry.
  - Voiding an Outbound (`OUT`) creates a compensating `VOID_OUT` entry.
  - Original transaction status is updated to `VOIDED`, referencing the reversal TxID and the mandatory operator reason.
- **Pre-Void Feasibility Check**:
  - An inbound transaction cannot be voided if downstream outbound transactions have already consumed the inventory:
    $$\text{CurrentStock}_{\text{batch}} \ge \text{Qty}_{\text{void}}$$
  - Prevents the creation of negative inventory balances.
- **PO State Rollback**:
  - If a voided `IN` transaction fulfilled a PO, the received quantity on `OPEN_POS` is automatically decremented:
    $$\text{QtyReceived}_{\text{new}} = \max(0, \text{QtyReceived}_{\text{prior}} - \text{Qty}_{\text{void}})$$
  - PO status is reverted accordingly:
    $$\text{RECEIVED} \xrightarrow{\text{Partial Void}} \text{PARTIAL} \xrightarrow{\text{Full Void}} \text{OPEN}$$

---

## 3. Operational Step-by-Step Procedures

### 3.1. Registering a New SKU
1. Navigate to the **Master SKU** tab in the sidebar.
2. Click **+ Add New SKU**.
3. Enter the `Item Code` (e.g., `SKU-1001`), `Item Name`, `Category`, `Unit`, and `Min Stock` threshold.
4. Click **Save SKU**. The record will be committed to Google Sheets and cached immediately.

### 3.2. Logging an In-Transit Purchase Order
1. Navigate to the **In-Transit POs** tab.
2. Click **+ Log In-Transit PO**.
3. Select the target SKU from the dropdown list.
4. Enter the `PO Number`, `Quantity Ordered`, expected `ETA` date, and vendor notes.
5. Click **Confirm PO**. The order status will become `OPEN` and `In-Transit Quantity` will increment immediately.

### 3.3. Receiving Inbound Goods (Dock Arrival)
1. Navigate to the **Dashboard** or **Stock & Batches** tab.
2. Click **Inbound (IN)**.
3. Select the SKU. If this delivery fulfills an open PO, select the PO from the dropdown.
4. Enter the `Lot Number` and `Expiration Date` (required for perishable goods).
5. Enter the `Received Quantity` (validated against remaining PO quota).
6. Click **Confirm Inbound**. The batch current stock and PO fulfillment progress update in real time.

### 3.4. Dispatching Outbound Goods (FEFO Picking)
1. Click **Outbound (OUT)**.
2. Select the target SKU.
3. The system presents available lots sorted by FEFO (earliest expiry first).
4. Select the lot and enter the dispatch quantity (validated against available lot stock).
5. Ensure the dispatch date is today or later than the lot receipt date.
6. Click **Confirm Outbound**.

### 3.5. Voiding an Erroneous Transaction
1. Navigate to the **Audit Ledger** tab.
2. Locate the erroneous transaction row.
3. Click the **Void** button.
4. Provide an explicit, audit-compliant explanation in the **Void Reason** prompt.
5. Click **Submit Void**. The system verifies pre-void feasibility, logs the reversal entry, restores inventory balances, and reopens linked POs if applicable.
