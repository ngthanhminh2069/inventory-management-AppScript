/**
 * OpenWMS - SMART INVENTORY CONTROL SYSTEM
 * Serverless Inventory & Warehouse Management Engine for Google Apps Script
 * Architecture: Google Sheets as Single Source of Truth (SSOT)
 * Runtime: Google Apps Script V8
 * License: MIT
 */

// Application Configuration
const APP_CONFIG = {
  APP_TITLE: 'OpenWMS - Smart Inventory Control',
  TIMEZONE: 'GMT+7',
  DATE_FORMAT: 'yyyy-MM-dd',
  DATETIME_FORMAT: 'yyyy-MM-dd HH:mm:ss',
  NEAR_EXPIRY_DAYS: 30,
  DEFAULT_OPERATOR: 'demo.user@example.com'
};

// Sheet Names Database Enum
const DB = {
  ITEMS: 'ITEMS',
  TRANSACTIONS: 'TRANSACTIONS',
  BATCHES: 'BATCHES',
  OPEN_POS: 'OPEN_POS'
};

/**
 * Returns current authenticated user email with a safe privacy fallback
 */
function getOperatorEmail() {
  try {
    return Session.getActiveUser().getEmail() || APP_CONFIG.DEFAULT_OPERATOR;
  } catch (e) {
    return APP_CONFIG.DEFAULT_OPERATOR;
  }
}

/**
 * Serves the Single-Page Web Application UI
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_CONFIG.APP_TITLE)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Ensures all required sheets and header schemas exist in the Google Spreadsheet
 */
function ensureSheetsExist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schemas = [
    { name: DB.ITEMS, headers: ['ItemCode', 'ItemName', 'Category', 'Unit', 'MinStock', 'CreatedAt'] },
    { name: DB.TRANSACTIONS, headers: ['TxID', 'Timestamp', 'Type', 'ItemCode', 'ItemName', 'LotNumber', 'ExpiryDate', 'Qty', 'Unit', 'Note', 'Operator', 'Status', 'RefTxID', 'VoidReason'] },
    { name: DB.BATCHES, headers: ['BatchKey', 'ItemCode', 'ItemName', 'LotNumber', 'ExpiryDate', 'QtyIn', 'QtyOut', 'CurrentStock', 'Status'] },
    { name: DB.OPEN_POS, headers: ['PoID', 'PoNumber', 'ItemCode', 'ItemName', 'QtyOrdered', 'QtyReceived', 'ETA', 'Status', 'CreatedAt', 'Operator', 'Notes'] }
  ];

  schemas.forEach(s => {
    let sheet = ss.getSheetByName(s.name);
    if (!sheet) {
      sheet = ss.insertSheet(s.name);
      sheet.appendRow(s.headers);
      sheet.getRange(1, 1, 1, s.headers.length).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
  });
}

/**
 * SINGLE SOURCE OF TRUTH (SSOT):
 * Computes all stock, FEFO lot balances, in-transit POs, and reorder alerts directly from Google Sheets.
 */
function getInitialAppData() {
  ensureSheetsExist();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const itemSheet = ss.getSheetByName(DB.ITEMS);
  const batchSheet = ss.getSheetByName(DB.BATCHES);
  const txSheet = ss.getSheetByName(DB.TRANSACTIONS);
  const poSheet = ss.getSheetByName(DB.OPEN_POS);

  const items = getSheetData(itemSheet);
  const batchesRaw = getSheetData(batchSheet);
  const txs = getSheetData(txSheet);
  const posRaw = getSheetData(poSheet);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let totalGrossStock = 0;
  let totalUsableStock = 0;
  let expiredLots = 0;
  let nearExpiryLots = 0;

  const stockByItem = {};          // Gross physical on-hand
  const usableStockByItem = {};    // Usable physical on-hand (D > 0 or non-perishable)
  const expiredStockByItem = {};   // Expired physical on-hand (D <= 0)
  const batchesByItem = {};

  const inTransitByItem = {};
  const openPosByItem = {};
  const activeOpenPOs = [];
  const allPOs = [];

  // 1. Process Open POs from Sheet OPEN_POS
  posRaw.forEach(p => {
    const status = String(p.Status || 'OPEN').trim().toUpperCase();
    const code = String(p.ItemCode || '').trim().toUpperCase();
    const qtyOrdered = Number(p.QtyOrdered) || 0;
    const qtyReceived = Number(p.QtyReceived) || 0;
    const remaining = Math.max(0, qtyOrdered - qtyReceived);

    const poObj = {
      poId: String(p.PoID || '').trim(),
      poNumber: String(p.PoNumber || '').trim().toUpperCase(),
      itemCode: code,
      itemName: String(p.ItemName || '').trim(),
      qtyOrdered: qtyOrdered,
      qtyReceived: qtyReceived,
      remaining: remaining,
      eta: p.ETA ? String(p.ETA).slice(0, 10) : 'N/A',
      status: status,
      createdAt: p.CreatedAt ? String(p.CreatedAt) : '',
      operator: String(p.Operator || ''),
      notes: String(p.Notes || '')
    };

    allPOs.push(poObj);

    if ((status === 'OPEN' || status === 'PARTIAL') && remaining > 0) {
      inTransitByItem[code] = (inTransitByItem[code] || 0) + remaining;
      openPosByItem[code] = openPosByItem[code] || [];
      openPosByItem[code].push(poObj);
      activeOpenPOs.push(poObj);
    }
  });

  allPOs.reverse();

  // 2. Process Batches / Lots from Sheet BATCHES (FEFO Logic)
  const batches = batchesRaw.filter(b => (Number(b.CurrentStock) || 0) > 0).map(b => {
    const stock = Number(b.CurrentStock) || 0;
    totalGrossStock += stock;
    const itemCode = String(b.ItemCode || '').trim().toUpperCase();
    stockByItem[itemCode] = (stockByItem[itemCode] || 0) + stock;

    let expStatus = 'Safe';
    let daysLeft = null;
    const expStr = String(b.ExpiryDate || '').trim();

    if (expStr && expStr !== 'N/A' && expStr !== 'None' && expStr !== '-') {
      const exp = new Date(expStr);
      if (!isNaN(exp.getTime())) {
        const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        const expMidnight = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate()).getTime();
        daysLeft = Math.ceil((expMidnight - todayMidnight) / (1000 * 60 * 60 * 24));

        if (daysLeft <= 0) {
          expStatus = 'Expired';
          expiredLots++;
          expiredStockByItem[itemCode] = (expiredStockByItem[itemCode] || 0) + stock;
        } else if (daysLeft <= APP_CONFIG.NEAR_EXPIRY_DAYS) {
          expStatus = 'NearExpiry';
          nearExpiryLots++;
          usableStockByItem[itemCode] = (usableStockByItem[itemCode] || 0) + stock;
          totalUsableStock += stock;
        } else {
          usableStockByItem[itemCode] = (usableStockByItem[itemCode] || 0) + stock;
          totalUsableStock += stock;
        }
      } else {
        expStatus = 'None';
        usableStockByItem[itemCode] = (usableStockByItem[itemCode] || 0) + stock;
        totalUsableStock += stock;
      }
    } else {
      expStatus = 'None';
      usableStockByItem[itemCode] = (usableStockByItem[itemCode] || 0) + stock;
      totalUsableStock += stock;
    }

    const batchObj = { 
      ...b,
      ItemCode: itemCode,
      ItemName: String(b.ItemName || ''),
      LotNumber: String(b.LotNumber || '').trim(),
      CurrentStock: stock,
      QtyIn: Number(b.QtyIn) || 0,
      QtyOut: Number(b.QtyOut) || 0,
      daysLeft: daysLeft, 
      expStatus: expStatus
    };

    batchesByItem[itemCode] = batchesByItem[itemCode] || [];
    batchesByItem[itemCode].push(batchObj);

    return batchObj;
  }).sort((a, b) => {
    // Sort ascending by expiration date: FEFO
    const dateA = (a.ExpiryDate && a.expStatus !== 'None' && a.ExpiryDate !== 'N/A') ? new Date(a.ExpiryDate) : new Date('9999-12-31');
    const dateB = (b.ExpiryDate && b.expStatus !== 'None' && b.ExpiryDate !== 'N/A') ? new Date(b.ExpiryDate) : new Date('9999-12-31');
    return dateA - dateB;
  });

  // 3. Build SKU Summary and 7-State Reorder Alerts using Usable On-Hand
  const skuSummary = [];
  const lowStockAlerts = [];

  items.forEach(it => {
    const code = String(it.ItemCode || '').trim().toUpperCase();
    const curGrossStock = stockByItem[code] || 0;
    const usableStock = usableStockByItem[code] || 0;
    const expiredStock = expiredStockByItem[code] || 0;
    const minStock = Number(it.MinStock) || 0;
    const inTransit = inTransitByItem[code] || 0;
    const effectiveStock = usableStock + inTransit;
    const activeLots = batchesByItem[code] || [];

    skuSummary.push({
      itemCode: code,
      itemName: String(it.ItemName || ''),
      category: String(it.Category || '-'),
      unit: String(it.Unit || ''),
      minStock: minStock,
      onHand: curGrossStock,
      usableStock: usableStock,
      expiredStock: expiredStock,
      inTransit: inTransit,
      effectiveStock: effectiveStock,
      lots: activeLots
    });

    // Reorder Alert Disambiguation Tree (Strictly evaluated against Usable Stock)
    if (minStock > 0 && usableStock <= minStock) {
      let status = 'LOW_STOCK';
      if (usableStock === 0 && inTransit === 0) {
        status = 'STOCKOUT';
      } else if (usableStock === 0 && effectiveStock >= minStock) {
        status = 'STOCKOUT_IN_TRANSIT';
      } else if (usableStock === 0 && effectiveStock < minStock) {
        status = 'STOCKOUT_PARTIAL_TRANSIT';
      } else if (usableStock > 0 && inTransit === 0) {
        status = 'LOW_STOCK';
      } else if (usableStock > 0 && effectiveStock >= minStock) {
        status = 'IN_TRANSIT_COVERED';
      } else if (usableStock > 0 && effectiveStock < minStock) {
        status = 'IN_TRANSIT_PARTIAL';
      }

      lowStockAlerts.push({
        ItemCode: code,
        ItemName: String(it.ItemName || ''),
        Category: String(it.Category || '-'),
        Unit: String(it.Unit || ''),
        CurrentStock: curGrossStock,
        UsableStock: usableStock,
        ExpiredStock: expiredStock,
        MinStock: minStock,
        InTransitQty: inTransit,
        EffectiveStock: effectiveStock,
        Deficit: Math.max(0, minStock - usableStock),
        NetDeficit: Math.max(0, minStock - effectiveStock),
        Status: status,
        ActivePOs: openPosByItem[code] || []
      });
    }
  });

  // 4. Top Consumed Items
  const consumedByItem = {};
  txs.forEach(t => {
    if (t.Status !== 'VOIDED' && !String(t.Type || '').startsWith('VOID_') && t.Type === 'OUT') {
      const code = String(t.ItemCode || '').trim().toUpperCase();
      consumedByItem[code] = consumedByItem[code] || { name: t.ItemName, qty: 0, unit: t.Unit || '' };
      consumedByItem[code].qty += Number(t.Qty) || 0;
    }
  });

  const topConsumed = Object.keys(consumedByItem)
    .map(k => ({ itemCode: k, name: consumedByItem[k].name, qty: consumedByItem[k].qty, unit: consumedByItem[k].unit }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  const activeEmail = getOperatorEmail();
  const reversedTxs = txs.reverse();

  return {
    currentUserEmail: activeEmail,
    items: items,
    skuSummary: skuSummary,
    batches: batches,
    lowStockAlerts: lowStockAlerts,
    activeOpenPOs: activeOpenPOs,
    allPOs: allPOs,
    allTransactions: reversedTxs,
    analytics: { topConsumed: topConsumed },
    dashboard: {
      kpis: {
        totalSKU: items.length,
        totalStock: totalGrossStock,
        totalUsableStock: totalUsableStock,
        totalActiveLots: batches.length,
        expiredLots: expiredLots,
        nearExpiryLots: nearExpiryLots,
        lowStockItems: lowStockAlerts.length,
        openPOCount: activeOpenPOs.length
      },
      recentTransactions: reversedTxs.slice(0, 10)
    }
  };
}

/**
 * Creates a new In-Transit Purchase Order with ScriptLock protection
 */
function createOpenPO(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    ensureSheetsExist();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet = ss.getSheetByName(DB.OPEN_POS);

    const poNumber = String(payload.poNumber || '').trim().toUpperCase();
    const itemCode = String(payload.itemCode || '').trim().toUpperCase();
    const qtyOrdered = Number(payload.qtyOrdered);
    const eta = payload.eta ? String(payload.eta).trim().slice(0, 10) : 'TBD';

    if (!poNumber) throw new Error('PO Number is required.');
    if (!itemCode) throw new Error('Item SKU is required.');
    if (!qtyOrdered || qtyOrdered <= 0) throw new Error('Ordered quantity must be greater than 0.');

    const poId = 'PO-' + Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss');
    const timestamp = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, APP_CONFIG.DATETIME_FORMAT);
    const operator = getOperatorEmail();

    poSheet.appendRow([
      poId, poNumber, itemCode, payload.itemName || '', qtyOrdered, 0,
      eta, 'OPEN', timestamp, operator, payload.notes || ''
    ]);

    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData() };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Cancels an Open PO with ScriptLock protection
 */
function cancelOpenPO(poId, reason) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet = ss.getSheetByName(DB.OPEN_POS);
    const data = poSheet.getDataRange().getValues();

    let targetRow = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(poId).trim() || String(data[i][1]).trim() === String(poId).trim()) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) throw new Error('PO not found: ' + poId);

    poSheet.getRange(targetRow, 8).setValue('CANCELLED');
    const existingNotes = data[targetRow - 1][10] || '';
    poSheet.getRange(targetRow, 11).setValue(`${existingNotes} [Cancelled: ${reason || 'No reason'}]`);

    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData() };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates an Inbound (IN) or Outbound (OUT) Transaction with FEFO, Temporal, and Over-Receipt Guardrails
 */
function createTransaction(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    ensureSheetsExist();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(DB.TRANSACTIONS);
    const batchSheet = ss.getSheetByName(DB.BATCHES);
    const poSheet = ss.getSheetByName(DB.OPEN_POS);

    const type = payload.type;
    const qty = Number(payload.qty);
    if (!qty || qty <= 0) throw new Error('Transaction quantity must be greater than 0');

    const itemCode = String(payload.itemCode || '').trim().toUpperCase();
    const lotNumber = (payload.lotNumber && String(payload.lotNumber).trim() !== '') 
                      ? String(payload.lotNumber).trim().toUpperCase() 
                      : 'N/A';
    const expiryDate = payload.expiryDate ? String(payload.expiryDate).trim() : 'N/A';
    const batchKey = `${itemCode}_${lotNumber}`;
    const txDate = payload.txDate ? String(payload.txDate).trim().slice(0, 10) : Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, APP_CONFIG.DATE_FORMAT);

    const txData = txSheet.getDataRange().getValues();

    // Temporal Consistency Guard: Outbound cannot be backdated earlier than earliest inbound
    if (type === 'OUT') {
      let earliestInDate = null;
      for (let i = 1; i < txData.length; i++) {
        const rowType = String(txData[i][2]).trim();
        const rowItem = String(txData[i][3]).trim().toUpperCase();
        const rowLot = String(txData[i][5]).trim().toUpperCase();
        const rowStatus = String(txData[i][11] || 'ACTIVE').trim().toUpperCase();

        if (rowType === 'IN' && rowItem === itemCode && rowLot === lotNumber && rowStatus !== 'VOIDED') {
          const rawDate = txData[i][1];
          const rowDateStr = (rawDate instanceof Date) 
            ? Utilities.formatDate(rawDate, APP_CONFIG.TIMEZONE, APP_CONFIG.DATE_FORMAT) 
            : String(rawDate).trim().slice(0, 10);
          if (!earliestInDate || rowDateStr < earliestInDate) earliestInDate = rowDateStr;
        }
      }

      if (earliestInDate && txDate < earliestInDate) {
        throw new Error(`Temporal Conflict: Cannot dispatch on [${txDate}]. Lot [${lotNumber}] was first received on [${earliestInDate}].`);
      }
    }

    const batchData = batchSheet.getDataRange().getValues();
    let batchRow = -1;
    let currentIn = 0;
    let currentOut = 0;
    let existingExpiry = '';

    for (let i = 1; i < batchData.length; i++) {
      if (String(batchData[i][0]).trim().toUpperCase() === batchKey) {
        batchRow = i + 1;
        existingExpiry = String(batchData[i][4] || '').trim();
        currentIn = Number(batchData[i][5]) || 0;
        currentOut = Number(batchData[i][6]) || 0;
        break;
      }
    }

    let linkedPoRef = '';

    if (type === 'IN') {
      if (batchRow > 0) {
        const isExpMismatch = (existingExpiry && existingExpiry !== 'N/A' && existingExpiry !== 'None') &&
                              (expiryDate && expiryDate !== 'N/A' && expiryDate !== 'None') &&
                              (existingExpiry.slice(0, 10) !== expiryDate.slice(0, 10));

        if (isExpMismatch) {
          throw new Error(`Lot Conflict: Lot [${lotNumber}] already exists with Expiry Date [${existingExpiry.slice(0, 10)}]. Conflicting dates are prohibited.`);
        }

        currentIn += qty;
        const newStock = currentIn - currentOut;
        batchSheet.getRange(batchRow, 6, 1, 3).setValues([[currentIn, currentOut, newStock]]);
        if ((!existingExpiry || existingExpiry === 'N/A') && expiryDate && expiryDate !== 'N/A') {
          batchSheet.getRange(batchRow, 5).setValue(expiryDate);
        }
      } else {
        batchSheet.appendRow([batchKey, itemCode, payload.itemName, lotNumber, expiryDate, qty, 0, qty, 'Active']);
      }

      // Reconciliation & Strict Anti-Over-Receipt Enforcement on Sheet OPEN_POS
      if (payload.linkedPoId || payload.linkedPoNumber) {
        const poData = poSheet.getDataRange().getValues();
        if (poData.length > 1) {
          const poHeaders = poData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
          const idCol = poHeaders.indexOf('poid') !== -1 ? poHeaders.indexOf('poid') : 0;
          const numCol = poHeaders.indexOf('ponumber') !== -1 ? poHeaders.indexOf('ponumber') : 1;
          const skuCol = poHeaders.indexOf('itemcode') !== -1 ? poHeaders.indexOf('itemcode') : 2;
          const ordCol = poHeaders.indexOf('qtyordered') !== -1 ? poHeaders.indexOf('qtyordered') : 4;
          const recCol = poHeaders.indexOf('qtyreceived') !== -1 ? poHeaders.indexOf('qtyreceived') : 5;
          const statCol = poHeaders.indexOf('status') !== -1 ? poHeaders.indexOf('status') : 7;

          const targetId = String(payload.linkedPoId || '').trim();
          const targetNum = String(payload.linkedPoNumber || '').trim().toUpperCase();

          for (let j = 1; j < poData.length; j++) {
            const row = poData[j];
            const rowId = String(row[idCol] || '').trim();
            const rowNum = String(row[numCol] || '').trim().toUpperCase();
            const rowSku = String(row[skuCol] || '').trim().toUpperCase();

            const isIdMatch = targetId && rowId && rowId === targetId;
            const isNumMatch = targetNum && rowNum === targetNum && (!rowSku || rowSku === itemCode);

            if (isIdMatch || isNumMatch) {
              const rowIdx = j + 1;
              const ordered = Number(row[ordCol]) || 0;
              const receivedBefore = Number(row[recCol]) || 0;
              const remaining = Math.max(0, ordered - receivedBefore);

              if (qty > remaining) {
                throw new Error(
                  `Over-receipt Violation: PO [${rowNum}] only has ${remaining} unit(s) remaining (Ordered: ${ordered}, Received: ${receivedBefore}). Cannot receive ${qty} units against this PO.`
                );
              }

              const newReceived = receivedBefore + qty;
              const newStatus = (newReceived >= ordered) ? 'RECEIVED' : 'PARTIAL';

              poSheet.getRange(rowIdx, recCol + 1).setValue(newReceived);
              poSheet.getRange(rowIdx, statCol + 1).setValue(newStatus);

              linkedPoRef = rowNum || rowId;
              break;
            }
          }
        }
      }
    } else if (type === 'OUT') {
      const available = currentIn - currentOut;
      if (batchRow === -1 || available < qty) {
        throw new Error(`Insufficient stock for Lot [${lotNumber}]! Available quantity: ${available}`);
      }
      currentOut += qty;
      const newStock = currentIn - currentOut;
      batchSheet.getRange(batchRow, 7, 1, 2).setValues([[currentOut, newStock]]);
    }

    const operatorEmail = getOperatorEmail();
    const txId = 'TX-' + Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss');
    const currentTimeStr = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'HH:mm:ss');
    const finalTimestamp = `${txDate} ${currentTimeStr}`;

    let noteText = payload.note || '';
    const poNumToLog = payload.linkedPoNumber || linkedPoRef;
    if (poNumToLog && !String(noteText).includes(poNumToLog)) {
      noteText = `[Fulfills PO: ${poNumToLog}] ${noteText}`.trim();
    }

    txSheet.appendRow([
      txId, finalTimestamp, type, itemCode, payload.itemName, lotNumber, expiryDate, qty,
      payload.unit || '', noteText, operatorEmail, 'ACTIVE', poNumToLog || '', ''
    ]);

    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData() };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Auditable Void Engine:
 * Generates compensating reversal entries (VOID_IN / VOID_OUT) with Idempotency Guard,
 * checks pre-void physical stock, and rolls back PO received quantities and status.
 */
function voidTransaction(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(DB.TRANSACTIONS);
    const batchSheet = ss.getSheetByName(DB.BATCHES);
    const poSheet = ss.getSheetByName(DB.OPEN_POS);

    const targetTxId = String(payload.txId || '').trim();
    const voidReason = String(payload.reason || '').trim();
    if (!voidReason) throw new Error('A void reason must be provided for audit compliance.');

    const txData = txSheet.getDataRange().getValues();
    let txRow = -1;
    let targetTx = null;

    for (let i = 1; i < txData.length; i++) {
      if (String(txData[i][0]).trim() === targetTxId) {
        txRow = i + 1;
        targetTx = {
          txId: txData[i][0],
          type: String(txData[i][2] || '').trim().toUpperCase(),
          itemCode: String(txData[i][3] || '').trim().toUpperCase(),
          itemName: txData[i][4],
          lotNumber: String(txData[i][5] || '').trim().toUpperCase(),
          expiryDate: txData[i][6],
          qty: Number(txData[i][7]) || 0,
          unit: txData[i][8],
          note: String(txData[i][9] || ''),
          operator: txData[i][10],
          status: String(txData[i][11] || 'ACTIVE').trim().toUpperCase(),
          refId: String(txData[i][12] || '').trim()
        };
        break;
      }
    }

    if (!targetTx) throw new Error('Transaction not found: ' + targetTxId);
    
    // Idempotency Guard: prevent double-voiding or voiding reversal entries
    if (targetTx.status === 'VOIDED' || targetTx.status === 'VOID_ENTRY' || targetTx.type.startsWith('VOID_')) {
      throw new Error(`Transaction [${targetTxId}] has already been voided or is a reversal entry.`);
    }

    // 1. Update Batch Quantities in Sheet BATCHES
    const batchKey = `${targetTx.itemCode}_${targetTx.lotNumber}`;
    const batchData = batchSheet.getDataRange().getValues();
    let batchRow = -1;
    let curIn = 0;
    let curOut = 0;
    let curStock = 0;

    for (let i = 1; i < batchData.length; i++) {
      if (String(batchData[i][0]).trim().toUpperCase() === batchKey) {
        batchRow = i + 1;
        curIn = Number(batchData[i][5]) || 0;
        curOut = Number(batchData[i][6]) || 0;
        curStock = Number(batchData[i][7]) || 0;
        break;
      }
    }

    if (batchRow > 0) {
      if (targetTx.type === 'IN') {
        // Pre-void Feasibility Check: cannot void inbound if inventory has already been consumed
        if (curStock < targetTx.qty) {
          throw new Error(`Cannot void Inbound [${targetTxId}]! Current physical stock (${curStock}) is less than void quantity (${targetTx.qty}). Items have already been consumed downstream.`);
        }
        curIn = Math.max(0, curIn - targetTx.qty);
        curStock = Math.max(0, curIn - curOut);
        batchSheet.getRange(batchRow, 6, 1, 3).setValues([[curIn, curOut, curStock]]);
      } else if (targetTx.type === 'OUT') {
        curOut = Math.max(0, curOut - targetTx.qty);
        curStock = Math.max(0, curIn - curOut);
        batchSheet.getRange(batchRow, 6, 1, 3).setValues([[curIn, curOut, curStock]]);
      }
    }

    // 2. Roll back PO Received Quantities and Status on Inbound Void
    if (targetTx.type === 'IN' && poSheet) {
      let linkedPoIdentifier = '';

      if (targetTx.refId && !targetTx.refId.startsWith('VOID-') && !targetTx.refId.startsWith('TX-')) {
        linkedPoIdentifier = targetTx.refId.toUpperCase();
      }

      if (!linkedPoIdentifier && targetTx.note) {
        const matchBracket = targetTx.note.match(/\[Fulfills PO:\s*([^\]]+)\]/i);
        const matchPlain = targetTx.note.match(/Fulfills PO:\s*([^\s,\]]+)/i);
        if (matchBracket && matchBracket[1]) {
          linkedPoIdentifier = matchBracket[1].trim().toUpperCase();
        } else if (matchPlain && matchPlain[1]) {
          linkedPoIdentifier = matchPlain[1].trim().toUpperCase();
        }
      }

      if (linkedPoIdentifier) {
        const poData = poSheet.getDataRange().getValues();
        if (poData.length > 1) {
          const poHeaders = poData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
          const idCol = poHeaders.indexOf('poid') !== -1 ? poHeaders.indexOf('poid') : 0;
          const numCol = poHeaders.indexOf('ponumber') !== -1 ? poHeaders.indexOf('ponumber') : 1;
          const skuCol = poHeaders.indexOf('itemcode') !== -1 ? poHeaders.indexOf('itemcode') : 2;
          const ordCol = poHeaders.indexOf('qtyordered') !== -1 ? poHeaders.indexOf('qtyordered') : 4;
          const recCol = poHeaders.indexOf('qtyreceived') !== -1 ? poHeaders.indexOf('qtyreceived') : 5;
          const statCol = poHeaders.indexOf('status') !== -1 ? poHeaders.indexOf('status') : 7;

          for (let j = 1; j < poData.length; j++) {
            const row = poData[j];
            const rowId = String(row[idCol] || '').trim().toUpperCase();
            const rowNum = String(row[numCol] || '').trim().toUpperCase();
            const rowSku = String(row[skuCol] || '').trim().toUpperCase();
            const rowStat = String(row[statCol] || '').trim().toUpperCase();

            if (rowStat !== 'CANCELLED' && (rowId === linkedPoIdentifier || rowNum === linkedPoIdentifier) && (!rowSku || rowSku === targetTx.itemCode)) {
              const rowIdx = j + 1;
              const ordered = Number(row[ordCol]) || 0;
              const receivedBefore = Number(row[recCol]) || 0;
              const newReceived = Math.max(0, receivedBefore - targetTx.qty);

              // Reverse State Machine: RECEIVED -> PARTIAL -> OPEN
              let newStatus = 'OPEN';
              if (newReceived >= ordered && ordered > 0) {
                newStatus = 'RECEIVED';
              } else if (newReceived > 0) {
                newStatus = 'PARTIAL';
              }

              poSheet.getRange(rowIdx, recCol + 1).setValue(newReceived);
              poSheet.getRange(rowIdx, statCol + 1).setValue(newStatus);
              break;
            }
          }
        }
      }
    }

    // 3. Flag original transaction as VOIDED and record compensating reversal row
    const operatorEmail = getOperatorEmail();
    const timestamp = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, APP_CONFIG.DATETIME_FORMAT);
    const reversalTxId = 'VOID-' + targetTxId;
    const reversalType = targetTx.type === 'IN' ? 'VOID_IN' : 'VOID_OUT';

    txSheet.getRange(txRow, 12, 1, 3).setValues([['VOIDED', reversalTxId, voidReason]]);

    txSheet.appendRow([
      reversalTxId, timestamp, reversalType, targetTx.itemCode, targetTx.itemName,
      targetTx.lotNumber, targetTx.expiryDate, targetTx.qty, targetTx.unit,
      `Reversal of ${targetTxId}. Reason: ${voidReason}`, operatorEmail, 'VOID_ENTRY', targetTxId, voidReason
    ]);

    SpreadsheetApp.flush();
    return { 
      success: true, 
      message: `Transaction [${targetTxId}] successfully voided; stock & PO status restored.`,
      appData: getInitialAppData()
    };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates or updates a Master SKU record in sheet ITEMS
 */
function saveMasterItem(item) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    ensureSheetsExist();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(DB.ITEMS);
    const data = sheet.getDataRange().getValues();
    
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toUpperCase() === String(item.ItemCode).trim().toUpperCase()) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 2, 1, 4).setValues([[item.ItemName, item.Category, item.Unit, item.MinStock]]);
    } else {
      sheet.appendRow([
        String(item.ItemCode).trim().toUpperCase(),
        item.ItemName,
        item.Category,
        item.Unit,
        Number(item.MinStock) || 0,
        new Date().toISOString()
      ]);
    }

    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData() };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Utility helper to convert 2D sheet data into an array of objects
 */
function getSheetData(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    let obj = {};
    headers.forEach((h, idx) => {
      let val = row[idx];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, APP_CONFIG.TIMEZONE, APP_CONFIG.DATETIME_FORMAT);
      }
      obj[h] = val;
    });
    return obj;
  });
}
