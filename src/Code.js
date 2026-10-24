/**
 * OpenWMS - SMART INVENTORY & PAYMENT CONTROL SYSTEM
 * Serverless Inventory, Lab Bench & Accounts Payable Engine for Google Apps Script
 * Architecture: Google Sheets as Single Source of Truth (SSOT)
 * Runtime: Google Apps Script V8
 * License: MIT
 */

const APP_CONFIG = {
  APP_TITLE: 'OpenWMS - Smart Inventory & Payment Control',
  TIMEZONE: APP_CONFIG.TIMEZONE,
  DATE_FORMAT: 'yyyy-MM-dd',
  DATETIME_FORMAT: 'yyyy-MM-dd HH:mm:ss',
  NEAR_EXPIRY_DAYS: 30,
  DEFAULT_OPERATOR: 'demo.user@example.com'
};

function getOperatorEmail() {
  try {
    return Session.getActiveUser().getEmail() || APP_CONFIG.DEFAULT_OPERATOR;
  } catch (e) {
    return APP_CONFIG.DEFAULT_OPERATOR;
  }
}

const DB = {
  ITEMS: 'ITEMS',
  TRANSACTIONS: 'TRANSACTIONS',
  BATCHES: 'BATCHES',
  OPEN_POS: 'OPEN_POS',
  PAYMENTS: 'PAYMENTS',
  IN_USE: 'IN_USE'
};

const TEXT_STRICT_COLS = ['lotnumber', 'itemcode', 'ponumber', 'invoiceno', 'txid', 'batchkey', 'inuseid', 'paymentid', 'reftxid', 'poid'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_CONFIG.APP_TITLE)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Menu quản trị trong Google Sheets để setup / bảo trì khi cần
 */
function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('OpenWMS Admin')
      .addItem('1. Verify / Setup Sheets Schema', 'ensureSheetsExist')
      .addItem('2. Sync Storage to Batches', 'backfillBatchesStorage')
      .addToUi();
  } catch (e) {
    // Tránh lỗi khi mở từ môi trường không hỗ trợ UI (e.g. Web App headless)
  }
}

/**
 * Chuẩn bị mảng giá trị 1 dòng theo Header + Ép kiểu Text để không bị xóa số 000
 */
function buildRowByHeaders(headers, rowObj) {
  const cleanHeaders = headers.map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
  const newRow = new Array(headers.length).fill('');
  
  for (const [key, value] of Object.entries(rowObj)) {
    const cleanKey = key.toLowerCase().replace(/[\s_]/g, '');
    const colIdx = cleanHeaders.indexOf(cleanKey);
    if (colIdx !== -1) {
      let finalVal = (value !== undefined && value !== null) ? value : '';
      const strVal = String(finalVal !== undefined && finalVal !== null ? finalVal : '').trim();
      if (TEXT_STRICT_COLS.includes(cleanKey) && /^\d+$/.test(strVal)) {
        finalVal = "'" + strVal.replace(/^'+/, '');
      }
      newRow[colIdx] = finalVal;
    }
  }
  return newRow;
}

/**
 * Ghi 1 dòng mới vào Sheet theo Header
 */
function appendRowByHeader(sheet, rowObj) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const newRow = buildRowByHeaders(headerRow, rowObj);
  sheet.appendRow(newRow);
}

/**
 * Ghi hàng loạt dòng vào Sheet (Batch Write) - cực nhanh (1 API call)
 */
function appendRowsByHeaders(sheet, rowsObjList) {
  if (!rowsObjList || rowsObjList.length === 0) return;
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const matrix = rowsObjList.map(obj => buildRowByHeaders(headerRow, obj));
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, matrix.length, matrix[0].length).setValues(matrix);
}

function ensureSheetsExist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schemas = [
    { name: DB.ITEMS, headers: ['ItemCode', 'ItemName', 'Category', 'Unit', 'MinStock', 'Storage', 'CreatedAt'] },
    { name: DB.TRANSACTIONS, headers: ['TxID', 'Timestamp', 'Type', 'ItemCode', 'ItemName', 'LotNumber', 'ExpiryDate', 'Qty', 'Unit', 'Note', 'Operator', 'Status', 'RefTxID', 'VoidReason'] },
    { name: DB.BATCHES, headers: ['BatchKey', 'ItemCode', 'ItemName', 'LotNumber', 'ExpiryDate', 'QtyIn', 'QtyOut', 'CurrentStock', 'Status', 'Storage'] },
    { name: DB.OPEN_POS, headers: ['PoID', 'PoNumber', 'ItemCode', 'ItemName', 'QtyOrdered', 'QtyReceived', 'ETA', 'Status', 'CreatedAt', 'Operator', 'Notes', 'VendorName', 'TotalAmount', 'Currency', 'PaymentTerms', 'PaidAmount', 'PaymentStatus', 'LineType', 'GoodsAmount', 'DeliveryFee', 'HandlingFee', 'OtherFees'] },
    { name: DB.PAYMENTS, headers: ['PaymentID', 'PaymentDate', 'PoNumber', 'VendorName', 'InvoiceNo', 'AmountPaid', 'Currency', 'RefDocUrl', 'Operator', 'Notes', 'CreatedAt', 'PoID', 'ItemCode', 'Status', 'VoidReason'] },
    { name: DB.IN_USE, headers: ['InUseID', 'TxID', 'ItemCode', 'ItemName', 'LotNumber', 'Qty', 'Unit', 'OpenedDate', 'OpenedBy', 'Status', 'ClosedDate', 'ClosedBy', 'Notes'] }
  ];

  schemas.forEach(s => {
    let sheet = ss.getSheetByName(s.name);
    if (!sheet) {
      sheet = ss.insertSheet(s.name);
      sheet.appendRow(s.headers);
      sheet.getRange(1, 1, 1, s.headers.length).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    } else {
      const currentHeaders = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
      s.headers.forEach(h => {
        const cleanH = h.toLowerCase().replace(/[\s_]/g, '');
        if (!currentHeaders.includes(cleanH)) {
          const nextCol = sheet.getLastColumn() + 1;
          sheet.getRange(1, nextCol).setValue(h).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
        }
      });
    }

    const headerVals = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
    headerVals.forEach((h, idx) => {
      const cleanH = String(h).trim().toLowerCase().replace(/[\s_]/g, '');
      if (TEXT_STRICT_COLS.includes(cleanH) && sheet.getMaxRows() > 1) {
        sheet.getRange(2, idx + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
      }
    });
  });
}

function getSheetData(sheet) {
  if (!sheet) return [];
  const range = sheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues();
  if (values.length <= 1) return [];
  const headers = values[0].map(h => String(h).trim());

  return values.slice(1).map((row, rIdx) => {
    let obj = {};
    headers.forEach((h, idx) => {
      const cleanKey = h.toLowerCase().replace(/[\s_]/g, '');
      let val = row[idx];
      if (TEXT_STRICT_COLS.includes(cleanKey)) {
        val = String(displayValues[rIdx + 1][idx] || '').trim().replace(/^'+/, '');
      } else if (val instanceof Date) {
        val = Utilities.formatDate(val, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
      }
      obj[h] = val;
      obj[cleanKey] = val;
    });
    return obj;
  });
}

/**
 * Đọc SSOT tinh gọn (Single Pass, không quét thừa)
 */
function getInitialAppData(ss, cachedItems) {
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const batchSheet = ss.getSheetByName(DB.BATCHES);
  const txSheet = ss.getSheetByName(DB.TRANSACTIONS);
  const poSheet = ss.getSheetByName(DB.OPEN_POS);
  const paySheet = ss.getSheetByName(DB.PAYMENTS);
  const inUseSheet = ss.getSheetByName(DB.IN_USE);

  let items = cachedItems;
  if (!items) {
    const itemSheet = ss.getSheetByName(DB.ITEMS);
    items = getSheetData(itemSheet);
  }

  const batchesRaw = getSheetData(batchSheet);
  const txs = getSheetData(txSheet);
  const posRaw = getSheetData(poSheet);
  const paymentsRaw = getSheetData(paySheet);
  const inUseRaw = inUseSheet ? getSheetData(inUseSheet) : [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let totalGrossStock = 0;
  let totalUsableStock = 0;
  let expiredLots = 0;
  let nearExpiryLots = 0;
  const stockByItem = {};          // Gross physical stock
  const usableStockByItem = {};    // Usable physical stock (D > 0 or non-perishable)
  const expiredStockByItem = {};   // Expired physical stock (D <= 0)
  const batchesByItem = {};

  const inTransitByItem = {};
  const openPosByItem = {};
  const activeOpenPOs = [];
  const allPOs = [];

  // 1. Quản lý In-Use
  const inUseByItem = {};
  const inUseLotsByItem = {};
  const activeInUseList = [];

  inUseRaw.forEach(u => {
    const status = String(u.status || u.Status || 'IN_USE').trim().toUpperCase();
    if (status === 'IN_USE') {
      const code = String(u.itemcode || u.ItemCode || '').trim().toUpperCase();
      const lotNumber = String(u.lotnumber || u.LotNumber || 'N/A').trim().replace(/^'+/, '');
      const qty = Number(u.qty ?? u.Qty ?? 0);

      const inUseObj = {
        inUseId: String(u.inuseid || u.InUseID || ''),
        txId: String(u.txid || u.TxID || ''),
        itemCode: code,
        itemName: String(u.itemname || u.ItemName || ''),
        lotNumber: lotNumber,
        qty: qty,
        unit: String(u.unit || u.Unit || ''),
        openedDate: (u.openeddate || u.OpenedDate) ? String(u.openeddate || u.OpenedDate).slice(0, 10) : '',
        openedBy: String(u.openedby || u.OpenedBy || ''),
        notes: String(u.notes || u.Notes || '')
      };

      inUseByItem[code] = (inUseByItem[code] || 0) + qty;
      inUseLotsByItem[code] = inUseLotsByItem[code] || [];
      inUseLotsByItem[code].push(inUseObj);
      activeInUseList.push(inUseObj);
    }
  });

  // 2. Thanh toán
  const paymentsByPoId = {};
  const paymentsByPoNum = {};
  const formattedPayments = [];

  paymentsRaw.forEach(py => {
    const pId = String(py.poid || py.PoID || '').trim();
    const pNum = String(py.ponumber || py.PoNumber || '').trim().toUpperCase();
    const status = String(py.status || py.Status || 'ACTIVE').trim().toUpperCase();

    const payObj = {
      paymentId: String(py.paymentid || py.PaymentID || ''),
      date: (py.paymentdate || py.PaymentDate) ? String(py.paymentdate || py.PaymentDate).slice(0, 10) : '',
      poId: pId,
      poNumber: pNum,
      itemCode: String(py.itemcode || py.ItemCode || ''),
      vendor: String(py.vendorname || py.VendorName || ''),
      invoiceNo: String(py.invoiceno || py.InvoiceNo || ''),
      amountPaid: Number(py.amountpaid ?? py.AmountPaid ?? 0),
      currency: String(py.currency || py.Currency || 'USD'),
      docUrl: String(py.refdocurl || py.RefDocUrl || ''),
      operator: String(py.operator || py.Operator || ''),
      notes: String(py.notes || py.Notes || ''),
      status: status,
      voidReason: String(py.voidreason || py.VoidReason || '')
    };

    formattedPayments.push(payObj);

    if (status !== 'VOIDED') {
      if (pId) {
        paymentsByPoId[pId] = paymentsByPoId[pId] || [];
        paymentsByPoId[pId].push(payObj);
      }
      if (pNum) {
        paymentsByPoNum[pNum] = paymentsByPoNum[pNum] || [];
        paymentsByPoNum[pNum].push(payObj);
      }
    }
  });

  // 3. Purchase Orders
  posRaw.forEach(p => {
    const poId = String(p.poid || p.PoID || '').trim();
    const poNumber = String(p.ponumber || p.PoNumber || '').trim().toUpperCase();
    const code = String(p.itemcode || p.ItemCode || '').trim().toUpperCase();
    const status = String(p.status || p.Status || 'OPEN').trim().toUpperCase();
    const qtyOrdered = Number(p.qtyordered ?? p.QtyOrdered ?? 0);
    const qtyReceived = Number(p.qtyreceived ?? p.QtyReceived ?? 0);
    const remaining = Math.max(0, qtyOrdered - qtyReceived);

    const totalAmount = Number(p.totalamount ?? p.TotalAmount ?? 0);
    const paidAmount = Number(p.paidamount ?? p.PaidAmount ?? 0);
    const remainingPayable = Math.max(0, totalAmount - paidAmount);
    
    let paymentStatus = String(p.paymentstatus || p.PaymentStatus || 'UNPAID').trim().toUpperCase();
    if (totalAmount > 0) {
      if (paidAmount >= totalAmount) paymentStatus = 'PAID';
      else if (paidAmount > 0) paymentStatus = 'PARTIAL';
      else paymentStatus = 'UNPAID';
    }

    const poPayments = (poId && paymentsByPoId[poId]) ? paymentsByPoId[poId] : (paymentsByPoNum[poNumber] || []);
    const latestInvoice = poPayments.length > 0 ? poPayments[poPayments.length - 1].invoiceNo : '';

    const poObj = {
      poId: poId,
      poNumber: poNumber,
      itemCode: code,
      itemName: String(p.itemname || p.ItemName || '').trim(),
      qtyOrdered: qtyOrdered,
      qtyReceived: qtyReceived,
      remaining: remaining,
      eta: (p.eta || p.ETA) ? String(p.eta || p.ETA).slice(0, 10) : 'N/A',
      status: status,
      createdAt: (p.createdat || p.CreatedAt) ? String(p.createdat || p.CreatedAt) : '',
      operator: String(p.operator || p.Operator || ''),
      notes: String(p.notes || p.Notes || ''),
      vendorName: String(p.vendorname || p.VendorName || 'Unassigned Vendor').trim(),
      totalAmount: totalAmount,
      paidAmount: paidAmount,
      remainingPayable: remainingPayable,
      currency: String(p.currency || p.Currency || 'USD').trim().toUpperCase(),
      paymentTerms: String(p.paymentterms || p.PaymentTerms || 'Net 30').trim(),
      paymentStatus: paymentStatus,
      latestInvoice: latestInvoice,
      paymentHistory: poPayments
    };

    const lineType = String(p.linetype || p.LineType || 'ITEM').toUpperCase();
    poObj.lineType = lineType;
    poObj.goodsAmount = Number(p.goodsamount ?? p.GoodsAmount ?? 0);
    poObj.deliveryFee = Number(p.deliveryfee ?? p.DeliveryFee ?? 0);
    poObj.handlingFee = Number(p.handlingfee ?? p.HandlingFee ?? 0);
    poObj.otherFees = Number(p.otherfees ?? p.OtherFees ?? 0);

    allPOs.push(poObj);

    if ((status === 'OPEN' || status === 'PARTIAL') && remaining > 0 && lineType !== 'FEE' && lineType !== 'NON_INVENTORY') {
      inTransitByItem[code] = (inTransitByItem[code] || 0) + remaining;
      openPosByItem[code] = openPosByItem[code] || [];
      openPosByItem[code].push(poObj);
      activeOpenPOs.push(poObj);
    }
  });

  allPOs.reverse();

  // Nhóm các dòng theo mã PoNumber để phục vụ hiển thị và thanh toán toàn bộ PO
  const poGroupsMap = {};
  allPOs.forEach(p => {
    const num = p.poNumber;
    if (!poGroupsMap[num]) {
      poGroupsMap[num] = {
        poNumber: num,
        vendorName: p.vendorName,
        currency: p.currency,
        paymentTerms: p.paymentTerms,
        eta: p.eta,
        createdAt: p.createdAt,
        totalAmount: 0,
        paidAmount: 0,
        remainingPayable: 0,
        paymentStatus: 'UNPAID',
        items: [],
        fees: []
      };
    }
    poGroupsMap[num].totalAmount += p.totalAmount;
    poGroupsMap[num].paidAmount += p.paidAmount;
    if (p.lineType === 'FEE') {
      poGroupsMap[num].fees.push(p);
    } else {
      poGroupsMap[num].items.push(p);
    }
  });

  const poGroups = Object.values(poGroupsMap).map(g => {
    g.remainingPayable = Math.max(0, g.totalAmount - g.paidAmount);
    if (g.totalAmount > 0) {
      if (g.paidAmount >= g.totalAmount) g.paymentStatus = 'PAID';
      else if (g.paidAmount > 0) g.paymentStatus = 'PARTIAL';
      else g.paymentStatus = 'UNPAID';
    }
    return g;
  });

  // 4. Batches
  const batches = batchesRaw.filter(b => (Number(b.currentstock ?? b.CurrentStock ?? 0)) > 0).map(b => {
    const stock = Number(b.currentstock ?? b.CurrentStock ?? 0);
    totalGrossStock += stock;
    const itemCode = String(b.itemcode || b.ItemCode || '').trim().toUpperCase();
    stockByItem[itemCode] = (stockByItem[itemCode] || 0) + stock;

    const lotNumber = String(b.lotnumber || b.LotNumber || '').trim().replace(/^'+/, '');
    let expStatus = 'Safe';
    let daysLeft = null;
    const expStr = String(b.expirydate || b.ExpiryDate || '').trim();

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
      ItemName: String(b.itemname || b.ItemName || ''),
      LotNumber: lotNumber,
      CurrentStock: stock,
      QtyIn: Number(b.qtyin ?? b.QtyIn ?? 0),
      QtyOut: Number(b.qtyout ?? b.QtyOut ?? 0),
      Storage: String(b.storage || b.Storage || ''),
      daysLeft: daysLeft, 
      expStatus: expStatus
    };

    batchesByItem[itemCode] = batchesByItem[itemCode] || [];
    batchesByItem[itemCode].push(batchObj);

    return batchObj;
  }).sort((a, b) => {
    const dateA = (a.ExpiryDate && a.expStatus !== 'None' && a.ExpiryDate !== 'N/A') ? new Date(a.ExpiryDate) : new Date('9999-12-31');
    const dateB = (b.ExpiryDate && b.expStatus !== 'None' && b.ExpiryDate !== 'N/A') ? new Date(b.ExpiryDate) : new Date('9999-12-31');
    return dateA - dateB;
  });

  // 5. SKU Summary
  const skuSummary = [];
  const lowStockAlerts = [];

  items.forEach(it => {
    const code = String(it.itemcode || it.ItemCode || '').trim().toUpperCase();
    const curStock = stockByItem[code] || 0;
    const usableStock = usableStockByItem[code] || 0;
    const expiredStock = expiredStockByItem[code] || 0;
    const minStock = Number(it.minstock ?? it.MinStock ?? 0);
    const inTransit = inTransitByItem[code] || 0;
    const effectiveStock = usableStock + inTransit;
    const activeLots = batchesByItem[code] || [];
    const inUseQty = inUseByItem[code] || 0;
    const inUseList = inUseLotsByItem[code] || [];

    skuSummary.push({
      itemCode: code,
      itemName: String(it.itemname || it.ItemName || ''),
      category: String(it.category || it.Category || '-'),
      unit: String(it.unit || it.Unit || ''),
      storage: String(it.storage || it.Storage || ''),
      minStock: minStock,
      onHand: curStock,
      usableStock: usableStock,
      expiredStock: expiredStock,
      inTransit: inTransit,
      effectiveStock: effectiveStock,
      inUseQty: inUseQty,
      inUseList: inUseList,
      lots: activeLots
    });

    // 7-State Reorder Disambiguation Tree (Strictly evaluated on Usable Stock)
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
        ItemName: String(it.itemname || it.ItemName || ''),
        Category: String(it.category || it.Category || '-'),
        Unit: String(it.unit || it.Unit || ''),
        CurrentStock: curStock,
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

  // 6. Top Consumed
  const consumedByItem = {};
  txs.forEach(t => {
    const tStat = String(t.status || t.Status || '').toUpperCase();
    const tType = String(t.type || t.Type || '').toUpperCase();
    const code = String(t.itemcode || t.ItemCode || '').trim().toUpperCase();
    t.LotNumber = String(t.lotnumber || t.LotNumber || '').trim().replace(/^'+/, '');

    if (tStat !== 'VOIDED' && !tType.startsWith('VOID_') && tType === 'OUT') {
      consumedByItem[code] = consumedByItem[code] || { name: t.itemname || t.ItemName, qty: 0, unit: t.unit || t.Unit || '' };
      consumedByItem[code].qty += Number(t.qty ?? t.Qty ?? 0);
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
    poGroups: poGroups,
    allPayments: formattedPayments.reverse(),
    allInUse: activeInUseList,
    allTransactions: reversedTxs,
    analytics: { topConsumed: topConsumed },
    dashboard: {
      kpis: {
        totalSKU: items.length,
        totalStock: totalGrossStock,
        totalUsableStock: totalUsableStock,
        inUseCount: activeInUseList.length,
        nearExpiryCount: nearExpiryLots,
        expiredCount: expiredLots,
        reorderCount: lowStockAlerts.length,
        inTransitPOCount: activeOpenPOs.length
      },
      recentTransactions: reversedTxs.slice(0, 10)
    }
  };
}

function _depleteInUseDirect(inUseSheet, targetInUseId, notes, operator, timestamp) {
  const data = inUseSheet.getDataRange().getValues();
  if (data.length <= 1) return;
  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
  const idCol = headers.indexOf('inuseid');
  const statCol = headers.indexOf('status');
  const cDateCol = headers.indexOf('closeddate');
  const cByCol = headers.indexOf('closedby');
  const notesCol = headers.indexOf('notes');

  for (let i = 1; i < data.length; i++) {
    if (idCol !== -1 && String(data[i][idCol]).trim() === targetInUseId) {
      const rowIdx = i + 1;
      if (statCol !== -1) inUseSheet.getRange(rowIdx, statCol + 1).setValue('DEPLETED');
      if (cDateCol !== -1) inUseSheet.getRange(rowIdx, cDateCol + 1).setValue(timestamp);
      if (cByCol !== -1) inUseSheet.getRange(rowIdx, cByCol + 1).setValue(operator);
      if (notesCol !== -1 && notes) {
        const curNotes = String(data[i][notesCol] || '');
        inUseSheet.getRange(rowIdx, notesCol + 1).setValue((curNotes + ' [Closed: ' + notes + ']').trim());
      }
      break;
    }
  }
}

function depleteInUseItem(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const inUseSheet = ss.getSheetByName(DB.IN_USE);
    if (!inUseSheet) throw new Error('Sheet IN_USE not found.');

    const targetInUseId = String(payload.inUseId || '').trim();
    if (!targetInUseId) throw new Error('InUseID is required.');

    const operator = getOperatorEmail();
    const timestamp = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    _depleteInUseDirect(inUseSheet, targetInUseId, payload.notes || '', operator, timestamp);

    SpreadsheetApp.flush();
    return { success: true, message: 'Item marked as completely consumed.', appData: getInitialAppData(ss) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function createTransaction(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(DB.TRANSACTIONS);
    const batchSheet = ss.getSheetByName(DB.BATCHES);
    const poSheet = ss.getSheetByName(DB.OPEN_POS);
    const inUseSheet = ss.getSheetByName(DB.IN_USE);

    const type = payload.type;
    const qty = Number(payload.qty);
    if (!qty || qty <= 0) throw new Error('Transaction quantity must be greater than 0');

    const itemCode = String(payload.itemCode || '').trim().toUpperCase();
    const lotNumber = (payload.lotNumber && String(payload.lotNumber).trim() !== '') 
                      ? String(payload.lotNumber).trim().replace(/^'+/, '') 
                      : 'N/A';
    const expiryDate = payload.expiryDate ? String(payload.expiryDate).trim() : 'N/A';
    const batchKey = `${itemCode}_${lotNumber}`;
    const txDate = payload.txDate ? String(payload.txDate).trim().slice(0, 10) : Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd');

    const txData = txSheet.getDataRange().getValues();
    const txDisplayData = txSheet.getDataRange().getDisplayValues();

    if (type === 'OUT') {
      let earliestInDate = null;
      for (let i = 1; i < txData.length; i++) {
        const rowType = String(txData[i][2]).trim();
        const rowItem = String(txData[i][3]).trim().toUpperCase();
        const rowLot = String(txDisplayData[i][5] || txData[i][5]).trim().replace(/^'+/, '');
        const rowStatus = String(txData[i][11] || 'ACTIVE').trim().toUpperCase();

        if (rowType === 'IN' && rowItem === itemCode && rowLot === lotNumber && rowStatus !== 'VOIDED') {
          const rawDate = txData[i][1];
          const rowDateStr = (rawDate instanceof Date) ? Utilities.formatDate(rawDate, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd') : String(rawDate).trim().slice(0, 10);
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
      let itemStorage = '';
      const itemSheet = ss.getSheetByName(DB.ITEMS);
      if (itemSheet) {
        const itemData = itemSheet.getDataRange().getValues();
        const itemHeaders = itemData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
        const sCol = itemHeaders.indexOf('storage');
        const cCol = itemHeaders.indexOf('itemcode');
        if (sCol !== -1 && cCol !== -1) {
          for (let k = 1; k < itemData.length; k++) {
            if (String(itemData[k][cCol]).trim().toUpperCase() === itemCode) {
              itemStorage = String(itemData[k][sCol] || '').trim();
              break;
            }
          }
        }
      }

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
        const bHeaders = batchSheet.getRange(1, 1, 1, Math.max(1, batchSheet.getLastColumn())).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
        const bStorageCol = bHeaders.indexOf('storage');
        if (bStorageCol !== -1 && itemStorage) {
          const curSt = String(batchSheet.getRange(batchRow, bStorageCol + 1).getValue() || '').trim();
          if (!curSt) batchSheet.getRange(batchRow, bStorageCol + 1).setValue(itemStorage);
        }
      } else {
        const batchRecord = {
          BatchKey: batchKey,
          ItemCode: itemCode,
          ItemName: payload.itemName,
          LotNumber: lotNumber,
          ExpiryDate: expiryDate,
          QtyIn: qty,
          QtyOut: 0,
          CurrentStock: qty,
          Status: 'Active',
          Storage: itemStorage
        };
        appendRowByHeader(batchSheet, batchRecord);
      }

      if (payload.linkedPoId || payload.linkedPoNumber) {
        const poData = poSheet.getDataRange().getValues();
        if (poData.length > 1) {
          const poHeaders = poData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
          const idCol = poHeaders.indexOf('poid');
          const numCol = poHeaders.indexOf('ponumber');
          const skuCol = poHeaders.indexOf('itemcode');
          const ordCol = poHeaders.indexOf('qtyordered');
          const recCol = poHeaders.indexOf('qtyreceived');
          const statCol = poHeaders.indexOf('status');

          const targetId = String(payload.linkedPoId || '').trim();
          const targetNum = String(payload.linkedPoNumber || '').trim().toUpperCase();

          for (let j = 1; j < poData.length; j++) {
            const row = poData[j];
            const rowId = idCol !== -1 ? String(row[idCol] || '').trim() : '';
            const rowNum = numCol !== -1 ? String(row[numCol] || '').trim().toUpperCase() : '';
            const rowSku = skuCol !== -1 ? String(row[skuCol] || '').trim().toUpperCase() : '';

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

    const txRecord = {
      TxID: txId,
      Timestamp: finalTimestamp,
      Type: type,
      ItemCode: itemCode,
      ItemName: payload.itemName,
      LotNumber: lotNumber,
      ExpiryDate: expiryDate,
      Qty: qty,
      Unit: payload.unit || '',
      Note: noteText,
      Operator: operatorEmail,
      Status: 'ACTIVE',
      RefTxID: poNumToLog || '',
      VoidReason: ''
    };

    appendRowByHeader(txSheet, txRecord);

    if (type === 'OUT' && payload.isMarkInUse && inUseSheet) {
      if (payload.closePreviousInUseId) {
        _depleteInUseDirect(inUseSheet, payload.closePreviousInUseId, 'Replaced by ' + txId, operatorEmail, finalTimestamp);
      }

      const inUseId = 'USE-' + Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss');
      const inUseRecord = {
        InUseID: inUseId,
        TxID: txId,
        ItemCode: itemCode,
        ItemName: payload.itemName,
        LotNumber: lotNumber,
        Qty: qty,
        Unit: payload.unit || '',
        OpenedDate: txDate,
        OpenedBy: operatorEmail,
        Status: 'IN_USE',
        ClosedDate: '',
        ClosedBy: '',
        Notes: payload.note || ''
      };
      appendRowByHeader(inUseSheet, inUseRecord);
    }

    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData(ss) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function voidTransaction(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(DB.TRANSACTIONS);
    const batchSheet = ss.getSheetByName(DB.BATCHES);
    const poSheet = ss.getSheetByName(DB.OPEN_POS);
    const inUseSheet = ss.getSheetByName(DB.IN_USE);

    const targetTxId = String(payload.txId || '').trim();
    const voidReason = String(payload.reason || '').trim();
    if (!voidReason) throw new Error('A void reason must be provided for audit compliance.');

    const txData = txSheet.getDataRange().getValues();
    const txDisplayData = txSheet.getDataRange().getDisplayValues();
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
          lotNumber: String(txDisplayData[i][5] || txData[i][5]).trim().replace(/^'+/, ''),
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
    if (targetTx.status === 'VOIDED' || targetTx.status === 'VOID_ENTRY') {
      throw new Error(`Transaction [${targetTxId}] has already been voided.`);
    }

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
        if (curStock < targetTx.qty) {
          throw new Error(`Cannot void Inbound [${targetTxId}]! Current physical stock (${curStock}) is less than void quantity (${targetTx.qty}). Items have already been consumed.`);
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

    if (targetTx.type === 'IN' && poSheet) {
      let linkedPoIdentifier = '';
      if (targetTx.refId && !targetTx.refId.startsWith('VOID-') && !targetTx.refId.startsWith('TX-')) {
        linkedPoIdentifier = targetTx.refId.toUpperCase();
      }

      if (!linkedPoIdentifier && targetTx.note) {
        const matchBracket = targetTx.note.match(/\[Fulfills PO:\s*([^\]]+)\]/i);
        const matchPlain = targetTx.note.match(/Fulfills PO:\s*([^\s,\]]+)/i);
        if (matchBracket && matchBracket[1]) linkedPoIdentifier = matchBracket[1].trim().toUpperCase();
        else if (matchPlain && matchPlain[1]) linkedPoIdentifier = matchPlain[1].trim().toUpperCase();
      }

      if (linkedPoIdentifier) {
        const poData = poSheet.getDataRange().getValues();
        if (poData.length > 1) {
          const poHeaders = poData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
          const idCol = poHeaders.indexOf('poid');
          const numCol = poHeaders.indexOf('ponumber');
          const skuCol = poHeaders.indexOf('itemcode');
          const ordCol = poHeaders.indexOf('qtyordered');
          const recCol = poHeaders.indexOf('qtyreceived');
          const statCol = poHeaders.indexOf('status');

          for (let j = 1; j < poData.length; j++) {
            const row = poData[j];
            const rowId = idCol !== -1 ? String(row[idCol] || '').trim().toUpperCase() : '';
            const rowNum = numCol !== -1 ? String(row[numCol] || '').trim().toUpperCase() : '';
            const rowSku = skuCol !== -1 ? String(row[skuCol] || '').trim().toUpperCase() : '';
            const rowStat = statCol !== -1 ? String(row[statCol] || '').trim().toUpperCase() : '';

            if (rowStat !== 'CANCELLED' && (rowId === linkedPoIdentifier || rowNum === linkedPoIdentifier) && (!rowSku || rowSku === targetTx.itemCode)) {
              const rowIdx = j + 1;
              const ordered = Number(row[ordCol]) || 0;
              const receivedBefore = Number(row[recCol]) || 0;
              const newReceived = Math.max(0, receivedBefore - targetTx.qty);

              let newStatus = 'OPEN';
              if (newReceived >= ordered && ordered > 0) newStatus = 'RECEIVED';
              else if (newReceived > 0) newStatus = 'PARTIAL';

              poSheet.getRange(rowIdx, recCol + 1).setValue(newReceived);
              poSheet.getRange(rowIdx, statCol + 1).setValue(newStatus);
              break;
            }
          }
        }
      }
    }

    if (targetTx.type === 'OUT' && inUseSheet) {
      const uData = inUseSheet.getDataRange().getValues();
      const uHeaders = uData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
      const txCol = uHeaders.indexOf('txid');
      const statCol = uHeaders.indexOf('status');
      const notesCol = uHeaders.indexOf('notes');

      for (let k = 1; k < uData.length; k++) {
        if (txCol !== -1 && String(uData[k][txCol]).trim() === targetTxId) {
          const currentInUseStatus = statCol !== -1 ? String(uData[k][statCol] || '').toUpperCase() : '';
          if (currentInUseStatus === 'DEPLETED') {
            throw new Error(`Cannot void Outbound transaction [${targetTxId}]: The associated bench item has already been marked as DEPLETED. Reversing this transaction would invent phantom warehouse inventory.`);
          }
          if (statCol !== -1) inUseSheet.getRange(k + 1, statCol + 1).setValue('VOIDED');
          if (notesCol !== -1) {
            const curN = String(uData[k][notesCol] || '');
            inUseSheet.getRange(k + 1, notesCol + 1).setValue((curN + ' [Voided with Tx ' + targetTxId + ']').trim());
          }
          break;
        }
      }
    }

    const operatorEmail = getOperatorEmail();
    const timestamp = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const reversalTxId = 'VOID-' + targetTxId;
    const reversalType = targetTx.type === 'IN' ? 'VOID_IN' : 'VOID_OUT';

    txSheet.getRange(txRow, 12, 1, 3).setValues([['VOIDED', reversalTxId, voidReason]]);

    const reversalRecord = {
      TxID: reversalTxId,
      Timestamp: timestamp,
      Type: reversalType,
      ItemCode: targetTx.itemCode,
      ItemName: targetTx.itemName,
      LotNumber: targetTx.lotNumber,
      ExpiryDate: targetTx.expiryDate,
      Qty: targetTx.qty,
      Unit: targetTx.unit,
      Note: `Reversal of ${targetTxId}. Reason: ${voidReason}`,
      Operator: operatorEmail,
      Status: 'VOID_ENTRY',
      RefTxID: targetTxId,
      VoidReason: voidReason
    };

    appendRowByHeader(txSheet, reversalRecord);

    return { 
      success: true, 
      message: `Transaction [${targetTxId}] successfully voided, stock & PO status restored.`,
      appData: getInitialAppData(ss)
    };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function createPayment(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet = ss.getSheetByName(DB.OPEN_POS);
    const paySheet = ss.getSheetByName(DB.PAYMENTS);

    const targetPoId = String(payload.poId || '').trim();
    const targetPoNumber = String(payload.poNumber || '').trim().toUpperCase();
    const amountPaid = Number(payload.amountPaid);
    const invoiceNo = String(payload.invoiceNo || '').trim();
    const paymentDate = payload.paymentDate ? String(payload.paymentDate).trim().slice(0, 10) : Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd');

    if (!targetPoId && !targetPoNumber) throw new Error('PO identifier is required.');
    if (!invoiceNo) throw new Error('Invoice Number is required.');
    if (!amountPaid || amountPaid <= 0) throw new Error('Payment amount must be greater than 0.');

    const poData = poSheet.getDataRange().getValues();
    const headers = poData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
    
    const idCol = headers.indexOf('poid');
    const numCol = headers.indexOf('ponumber');
    const totCol = headers.indexOf('totalamount');
    const paidCol = headers.indexOf('paidamount');
    const pStatCol = headers.indexOf('paymentstatus');
    const currCol = headers.indexOf('currency');
    const venCol = headers.indexOf('vendorname');

    // Tìm tất cả các dòng khớp với PO này (nếu chọn theo PoNumber thì khớp tất cả các dòng của PO đó)
    const matchedRows = [];
    let currentTotal = 0;
    let currentPaid = 0;
    let poCurrency = 'USD';
    let vendor = '';
    let resolvedPoNumber = targetPoNumber;

    for (let i = 1; i < poData.length; i++) {
      const rowId = idCol !== -1 ? String(poData[i][idCol] || '').trim() : '';
      const rowNum = numCol !== -1 ? String(poData[i][numCol] || '').trim().toUpperCase() : '';

      const isMatch = (targetPoNumber && rowNum === targetPoNumber) ||
                      (!targetPoNumber && targetPoId && rowId === targetPoId);

      if (isMatch) {
        const rowTot = totCol !== -1 ? (Number(poData[i][totCol]) || 0) : 0;
        const rowPaid = paidCol !== -1 ? (Number(poData[i][paidCol]) || 0) : 0;
        currentTotal += rowTot;
        currentPaid += rowPaid;
        poCurrency = currCol !== -1 ? String(poData[i][currCol] || 'USD') : 'USD';
        vendor = venCol !== -1 ? String(poData[i][venCol] || '') : '';
        resolvedPoNumber = rowNum;

        matchedRows.push({
          rowIdx: i + 1,
          total: rowTot,
          paid: rowPaid
        });
      }
    }

    if (matchedRows.length === 0) throw new Error(`PO [${targetPoNumber || targetPoId}] not found in OPEN_POS.`);

    // Guard against paying cancelled POs
    const statusCol = headers.indexOf('status');
    for (let i = 1; i < poData.length; i++) {
      const rowId = idCol !== -1 ? String(poData[i][idCol] || '').trim() : '';
      const rowNum = numCol !== -1 ? String(poData[i][numCol] || '').trim().toUpperCase() : '';
      if ((targetPoNumber && rowNum === targetPoNumber) || (!targetPoNumber && targetPoId && rowId === targetPoId)) {
        const poStatus = statusCol !== -1 ? String(poData[i][statusCol] || '').toUpperCase() : '';
        if (poStatus === 'CANCELLED') {
          throw new Error(`Cannot record payment for cancelled PO [${resolvedPoNumber}].`);
        }
      }
    }

    const remainingPayable = Math.max(0, currentTotal - currentPaid);
    if (amountPaid > (remainingPayable + 0.0001)) {
      throw new Error(`Overpayment violation: Remaining balance for PO [${resolvedPoNumber}] is only ${remainingPayable.toLocaleString()} ${poCurrency}. Cannot pay ${amountPaid.toLocaleString()} ${poCurrency}.`);
    }

    // Phân bổ số tiền thanh toán vào các dòng của PO
    let remainingToAllocate = amountPaid;
    matchedRows.forEach(m => {
      const lineDue = Math.max(0, m.total - m.paid);
      let alloc = 0;
      if (remainingToAllocate > 0) {
        alloc = Math.min(remainingToAllocate, lineDue > 0 ? lineDue : remainingToAllocate);
        remainingToAllocate -= alloc;
      }
      const newPaid = m.paid + alloc;
      let newStatus = 'PARTIAL';
      if (m.total > 0 && newPaid >= m.total) newStatus = 'PAID';
      else if (newPaid <= 0) newStatus = 'UNPAID';

      if (paidCol !== -1) poSheet.getRange(m.rowIdx, paidCol + 1).setValue(newPaid);
      if (pStatCol !== -1) poSheet.getRange(m.rowIdx, pStatCol + 1).setValue(newStatus);
    });

    const payId = 'PAY-' + Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss');
    const operator = getOperatorEmail();
    const timestamp = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    const paymentRecord = {
      PaymentID: payId,
      PaymentDate: paymentDate,
      PoID: targetPoId || matchedRows[0].rowIdx,
      PoNumber: resolvedPoNumber,
      ItemCode: 'ALL_ITEMS_AND_FEES',
      VendorName: vendor,
      InvoiceNo: invoiceNo,
      AmountPaid: amountPaid,
      Currency: poCurrency,
      RefDocUrl: payload.docUrl || '',
      Operator: operator,
      Notes: payload.notes || '',
      CreatedAt: timestamp,
      Status: 'ACTIVE',
      VoidReason: ''
    };

    appendRowByHeader(paySheet, paymentRecord);

    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData(ss) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function voidPayment(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const paySheet = ss.getSheetByName(DB.PAYMENTS);
    const poSheet = ss.getSheetByName(DB.OPEN_POS);

    const paymentId = String(payload.paymentId || '').trim();
    const voidReason = String(payload.reason || '').trim();
    if (!voidReason) throw new Error('A void reason must be provided for audit compliance.');

    const payData = paySheet.getDataRange().getValues();
    const headers = payData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
    
    const idCol = headers.indexOf('paymentid');
    const pIdCol = headers.indexOf('poid');
    const pNumCol = headers.indexOf('ponumber');
    const amtCol = headers.indexOf('amountpaid');
    const statCol = headers.indexOf('status');
    const rsnCol = headers.indexOf('voidreason');

    let targetPayRow = -1;
    let targetPoId = '';
    let targetPoNum = '';
    let voidAmount = 0;

    for (let i = 1; i < payData.length; i++) {
      if (String(payData[i][idCol]).trim() === paymentId) {
        targetPayRow = i + 1;
        if (statCol !== -1 && String(payData[i][statCol] || 'ACTIVE').toUpperCase() === 'VOIDED') {
          throw new Error(`Payment [${paymentId}] has already been voided.`);
        }
        targetPoId = pIdCol !== -1 ? String(payData[i][pIdCol] || '').trim() : '';
        targetPoNum = pNumCol !== -1 ? String(payData[i][pNumCol] || '').trim().toUpperCase() : '';
        voidAmount = amtCol !== -1 ? (Number(payData[i][amtCol]) || 0) : 0;
        break;
      }
    }

    if (targetPayRow === -1) throw new Error('Payment record not found: ' + paymentId);

    if (statCol !== -1) paySheet.getRange(targetPayRow, statCol + 1).setValue('VOIDED');
    if (rsnCol !== -1) paySheet.getRange(targetPayRow, rsnCol + 1).setValue(voidReason);

    const poData = poSheet.getDataRange().getValues();
    const poHeaders = poData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
    
    const poIdCol = poHeaders.indexOf('poid');
    const poNumCol = poHeaders.indexOf('ponumber');
    const totCol = poHeaders.indexOf('totalamount');
    const paidCol = poHeaders.indexOf('paidamount');
    const pStatCol = poHeaders.indexOf('paymentstatus');

    let remainingToVoid = voidAmount;
    const matchingPoRows = [];
    for (let j = 1; j < poData.length; j++) {
      const rowId = poIdCol !== -1 ? String(poData[j][poIdCol] || '').trim() : '';
      const rowNum = poNumCol !== -1 ? String(poData[j][poNumCol] || '').trim().toUpperCase() : '';

      if ((targetPoNum && rowNum === targetPoNum) || (!targetPoNum && targetPoId && rowId === targetPoId)) {
        matchingPoRows.push({
          rowIdx: j + 1,
          total: totCol !== -1 ? (Number(poData[j][totCol]) || 0) : 0,
          paid: paidCol !== -1 ? (Number(poData[j][paidCol]) || 0) : 0
        });
      }
    }

    for (let k = matchingPoRows.length - 1; k >= 0; k--) {
      const m = matchingPoRows[k];
      const deduct = Math.min(remainingToVoid, m.paid);
      const newPaid = Math.max(0, m.paid - deduct);
      remainingToVoid -= deduct;

      let newStatus = 'UNPAID';
      if (m.total > 0 && newPaid >= m.total) newStatus = 'PAID';
      else if (newPaid > 0) newStatus = 'PARTIAL';

      if (paidCol !== -1) poSheet.getRange(m.rowIdx, paidCol + 1).setValue(newPaid);
      if (pStatCol !== -1) poSheet.getRange(m.rowIdx, pStatCol + 1).setValue(newStatus);

      if (remainingToVoid <= 0) break;
    }

    return { success: true, message: `Payment [${paymentId}] successfully voided and PO balance restored.`, appData: getInitialAppData(ss) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function createOpenPO(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet = ss.getSheetByName(DB.OPEN_POS);

    const poNumber = String(payload.poNumber || '').trim().toUpperCase();
    if (!poNumber) throw new Error('PO Number is required.');

    const vendorName = String(payload.vendorName || 'Unassigned').trim();
    const currency = String(payload.currency || 'USD').trim().toUpperCase();
    const paymentTerms = String(payload.paymentTerms || 'Net 30').trim();
    const eta = payload.eta ? String(payload.eta).trim().slice(0, 10) : 'TBD';
    const notes = String(payload.notes || '').trim();
    const timestamp = Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const operator = getOperatorEmail();

    const deliveryFee = Number(payload.deliveryFee) || 0;
    const handlingFee = Number(payload.handlingFee) || 0;
    const otherFees = Number(payload.otherFees) || 0;
    const totalFees = deliveryFee + handlingFee + otherFees;

    // Hỗ trợ cả multi-line items và single-item legacy payload
    const items = payload.items && Array.isArray(payload.items) && payload.items.length > 0
                  ? payload.items
                  : [{
                      itemCode: payload.itemCode,
                      itemName: payload.itemName,
                      qtyOrdered: payload.qtyOrdered,
                      amount: Number(payload.totalAmount) || 0
                    }];

    items.forEach((it, idx) => {
      const sku = String(it.itemCode || '').trim().toUpperCase();
      const qty = Number(it.qtyOrdered);
      if (!sku) throw new Error(`Item ${idx + 1}: SKU is required.`);
      if (!qty || qty <= 0) throw new Error(`Item ${idx + 1}: Ordered quantity must be greater than 0.`);
    });

    const allPoRecords = [];

    // 1. Ghi từng dòng vật tư
    items.forEach((it, idx) => {
      const sku = String(it.itemCode || '').trim().toUpperCase();
      const qty = Number(it.qtyOrdered);
      const lineAmount = Number(it.amount ?? it.totalAmount ?? 0);
      const poId = 'PO-' + Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss') + '-' + (idx + 1);

      const poRecord = {
        PoID: poId,
        PoNumber: poNumber,
        ItemCode: sku,
        ItemName: it.itemName || '',
        QtyOrdered: qty,
        QtyReceived: 0,
        ETA: eta,
        Status: 'OPEN',
        CreatedAt: timestamp,
        Operator: operator,
        Notes: notes,
        VendorName: vendorName,
        TotalAmount: lineAmount,
        Currency: currency,
        PaymentTerms: paymentTerms,
        PaidAmount: 0,
        PaymentStatus: 'UNPAID',
        LineType: 'ITEM',
        GoodsAmount: lineAmount,
        DeliveryFee: 0,
        HandlingFee: 0,
        OtherFees: 0
      };
      allPoRecords.push(poRecord);
    });

    // 2. Ghi dòng phụ phí (Delivery, Handling, Thuế...) nếu có
    if (totalFees > 0) {
      const feePoId = 'PO-' + Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss') + '-FEE';
      const feeNotesParts = [];
      if (deliveryFee > 0) feeNotesParts.push(`Delivery: ${deliveryFee}`);
      if (handlingFee > 0) feeNotesParts.push(`Handling: ${handlingFee}`);
      if (otherFees > 0) feeNotesParts.push(`Other: ${otherFees}`);

      const feeRecord = {
        PoID: feePoId,
        PoNumber: poNumber,
        ItemCode: 'FEE_LOGISTICS',
        ItemName: 'Logistics & Handling Fees',
        QtyOrdered: 1,
        QtyReceived: 1,
        ETA: eta,
        Status: 'RECEIVED',
        CreatedAt: timestamp,
        Operator: operator,
        Notes: `${notes} [${feeNotesParts.join(', ')}]`.trim(),
        VendorName: vendorName,
        TotalAmount: totalFees,
        Currency: currency,
        PaymentTerms: paymentTerms,
        PaidAmount: 0,
        PaymentStatus: 'UNPAID',
        LineType: 'FEE',
        GoodsAmount: 0,
        DeliveryFee: deliveryFee,
        HandlingFee: handlingFee,
        OtherFees: otherFees
      };
      allPoRecords.push(feeRecord);
    }

    // Ghi hàng loạt (Batch write - 1 API call)
    appendRowsByHeaders(poSheet, allPoRecords);

    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData(ss) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function cancelOpenPO(poId, reason) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const poSheet = ss.getSheetByName(DB.OPEN_POS);
    const data = poSheet.getDataRange().getValues();
    if (data.length <= 1) throw new Error('No PO records found.');

    const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
    const idCol = headers.indexOf('poid');
    const numCol = headers.indexOf('ponumber');
    const recCol = headers.indexOf('qtyreceived');
    const paidCol = headers.indexOf('paidamount');
    const statCol = headers.indexOf('status');
    const notesCol = headers.indexOf('notes');

    const targetIdentifier = String(poId || '').trim().toUpperCase();
    const targetRows = [];
    let hasReceiptOrPayment = false;
    let resolvedPoNumber = targetIdentifier;

    for (let i = 1; i < data.length; i++) {
      const rowId = idCol !== -1 ? String(data[i][idCol] || '').trim().toUpperCase() : '';
      const rowNum = numCol !== -1 ? String(data[i][numCol] || '').trim().toUpperCase() : '';

      if (rowId === targetIdentifier || rowNum === targetIdentifier) {
        resolvedPoNumber = rowNum || rowId;
        const rec = recCol !== -1 ? (Number(data[i][recCol]) || 0) : 0;
        const paid = paidCol !== -1 ? (Number(data[i][paidCol]) || 0) : 0;
        if (rec > 0 || paid > 0) {
          hasReceiptOrPayment = true;
        }
        targetRows.push({
          rowIdx: i + 1,
          existingNotes: notesCol !== -1 ? String(data[i][notesCol] || '') : ''
        });
      }
    }

    if (targetRows.length === 0) throw new Error('PO not found: ' + poId);
    if (hasReceiptOrPayment) {
      throw new Error(`Cannot cancel PO [${resolvedPoNumber}]: Items have already been partially/fully received or paid.`);
    }

    targetRows.forEach(t => {
      if (statCol !== -1) poSheet.getRange(t.rowIdx, statCol + 1).setValue('CANCELLED');
      if (notesCol !== -1) {
        poSheet.getRange(t.rowIdx, notesCol + 1).setValue(`${t.existingNotes} [Cancelled: ${reason || 'No reason'}]`.trim());
      }
    });

    SpreadsheetApp.flush();
    SpreadsheetApp.flush();
    return { success: true, appData: getInitialAppData(ss) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

function saveMasterItem(item) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(DB.ITEMS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
    
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toUpperCase() === String(item.ItemCode).trim().toUpperCase()) {
        rowIndex = i + 1;
        break;
      }
    }

    const storageVal = item.Storage || item.storage || '';

    if (rowIndex > 0) {
      const nameCol = headers.indexOf('itemname');
      const catCol = headers.indexOf('category');
      const unitCol = headers.indexOf('unit');
      const minCol = headers.indexOf('minstock');
      const stCol = headers.indexOf('storage');

      if (nameCol !== -1) sheet.getRange(rowIndex, nameCol + 1).setValue(item.ItemName);
      if (catCol !== -1) sheet.getRange(rowIndex, catCol + 1).setValue(item.Category);
      if (unitCol !== -1) sheet.getRange(rowIndex, unitCol + 1).setValue(item.Unit);
      if (minCol !== -1) sheet.getRange(rowIndex, minCol + 1).setValue(Number(item.MinStock) || 0);
      if (stCol !== -1) sheet.getRange(rowIndex, stCol + 1).setValue(storageVal);
    } else {
      const itemRecord = {
        ItemCode: String(item.ItemCode).trim().toUpperCase(),
        ItemName: item.ItemName,
        Category: item.Category,
        Unit: item.Unit,
        MinStock: Number(item.MinStock) || 0,
        Storage: storageVal,
        CreatedAt: new Date().toISOString()
      };
      appendRowByHeader(sheet, itemRecord);
    }

    return { success: true, appData: getInitialAppData(ss, null) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Quét tự động bổ sung Storage cho các lô hàng trong BATCHES chưa có Storage (Tối ưu Batch Writing)
 */
function backfillBatchesStorage() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const batchSheet = ss.getSheetByName(DB.BATCHES);
  const itemSheet = ss.getSheetByName(DB.ITEMS);
  if (!batchSheet || !itemSheet) return;

  const itemData = itemSheet.getDataRange().getValues();
  if (itemData.length <= 1) return;
  const itemHeaders = itemData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
  const iSkuCol = itemHeaders.indexOf('itemcode');
  const iStorageCol = itemHeaders.indexOf('storage');
  if (iSkuCol === -1 || iStorageCol === -1) return;

  const storageMap = {};
  for (let i = 1; i < itemData.length; i++) {
    const sku = String(itemData[i][iSkuCol]).trim().toUpperCase();
    const st = String(itemData[i][iStorageCol] || '').trim();
    if (sku) storageMap[sku] = st;
  }

  const batchData = batchSheet.getDataRange().getValues();
  if (batchData.length <= 1) return;
  const batchHeaders = batchData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
  const bSkuCol = batchHeaders.indexOf('itemcode');
  let bStorageCol = batchHeaders.indexOf('storage');

  if (bStorageCol === -1) {
    bStorageCol = batchSheet.getLastColumn();
    batchSheet.getRange(1, bStorageCol + 1).setValue('Storage').setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
  }

  let updatedCount = 0;
  const storageColumnValues = [];
  for (let j = 1; j < batchData.length; j++) {
    const sku = String(batchData[j][bSkuCol]).trim().toUpperCase();
    let currentStorage = bStorageCol < batchData[j].length ? String(batchData[j][bStorageCol] || '').trim() : '';
    if (!currentStorage && storageMap[sku]) {
      currentStorage = storageMap[sku];
      updatedCount++;
    }
    storageColumnValues.push([currentStorage]);
  }

  if (updatedCount > 0) {
    batchSheet.getRange(2, bStorageCol + 1, storageColumnValues.length, 1).setValues(storageColumnValues);
  }
}

/**
 * Nhập tồn kho ban đầu hàng loạt (Tối ưu hóa Batch Writing cực nhanh)
 */
function bulkInitialInventory(records) {
  if (!records || !Array.isArray(records) || records.length === 0) {
    throw new Error('No records provided for bulk import.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const itemSheet = ss.getSheetByName(DB.ITEMS);
    const batchSheet = ss.getSheetByName(DB.BATCHES);
    const txSheet = ss.getSheetByName(DB.TRANSACTIONS);

    // 1. Tải danh mục Master ITEMS
    const itemData = itemSheet.getDataRange().getValues();
    const itemHeaders = itemData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
    const iSkuIdx = itemHeaders.indexOf('itemcode');
    const iNameIdx = itemHeaders.indexOf('itemname');
    const iUnitIdx = itemHeaders.indexOf('unit');
    const iStorageIdx = itemHeaders.indexOf('storage');

    const itemMap = {};
    for (let i = 1; i < itemData.length; i++) {
      const sku = String(itemData[i][iSkuIdx]).trim().toUpperCase();
      if (sku) {
        itemMap[sku] = {
          name: iNameIdx !== -1 ? String(itemData[i][iNameIdx] || '').trim() : '',
          unit: iUnitIdx !== -1 ? String(itemData[i][iUnitIdx] || '').trim() : '',
          storage: iStorageIdx !== -1 ? String(itemData[i][iStorageIdx] || '').trim() : ''
        };
      }
    }

    // 2. Kiểm tra tính hợp lệ của toàn bộ danh sách trước khi ghi
    for (let r = 0; r < records.length; r++) {
      const row = records[r];
      const sku = String(row.itemCode || row.sku || '').trim().toUpperCase();
      const qty = Number(row.qty);

      if (!sku) throw new Error(`Row ${r + 1}: SKU is required.`);
      if (!itemMap[sku]) throw new Error(`Row ${r + 1}: SKU [${sku}] not found in Master ITEMS.`);
      if (!qty || qty <= 0) throw new Error(`Row ${r + 1}: Quantity must be greater than 0.`);
    }

    // 3. Tải dữ liệu BATCHES hiện tại
    const batchData = batchSheet.getDataRange().getValues();
    const batchHeaders = batchData[0].map(h => String(h).trim().toLowerCase().replace(/[\s_]/g, ''));
    const bKeyCol = batchHeaders.indexOf('batchkey');
    const bInCol = batchHeaders.indexOf('qtyin');
    const bOutCol = batchHeaders.indexOf('qtyout');
    const bStockCol = batchHeaders.indexOf('currentstock');
    const bExpCol = batchHeaders.indexOf('expirydate');
    const bStorageCol = batchHeaders.indexOf('storage');

    const batchRowMap = {};
    for (let j = 1; j < batchData.length; j++) {
      const key = String(batchData[j][bKeyCol]).trim().toUpperCase();
      if (key) {
        batchRowMap[key] = {
          rowIdx: j + 1,
          dataRowIdx: j,
          expiry: String(batchData[j][bExpCol] || '').trim(),
          qtyIn: Number(batchData[j][bInCol]) || 0,
          qtyOut: bOutCol !== -1 ? (Number(batchData[j][bOutCol]) || 0) : 0
        };
      }
    }

    const operator = getOperatorEmail();
    const now = new Date();
    const timestampStr = Utilities.formatDate(now, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const datePrefix = Utilities.formatDate(now, APP_CONFIG.TIMEZONE, 'yyyyMMdd-HHmmss');

    const newBatchesToAppend = [];
    const newTxToAppend = [];
    let existingBatchesModified = false;

    // 4. Xử lý từng dòng nhập kho trong RAM
    records.forEach((rec, idx) => {
      const sku = String(rec.itemCode || rec.sku || '').trim().toUpperCase();
      const rawLot = rec.lotNumber || rec.lot;
      const lot = (rawLot && String(rawLot).trim() !== '') 
                  ? String(rawLot).trim().replace(/^'+/, '') 
                  : 'DEFAULT';
      const rawExp = rec.expiryDate || rec.expiry;
      const exp = rawExp ? String(rawExp).trim() : 'N/A';
      const qty = Number(rec.qty);
      const batchKey = `${sku}_${lot}`;
      const itemInfo = itemMap[sku];
      const customNote = rec.note ? String(rec.note).trim() : '';
      const finalNote = customNote ? `[Initial Stock] ${customNote}` : '[Initial Stock] Tồn kho ban đầu';

      if (batchRowMap[batchKey]) {
        // Lô đã tồn tại -> cộng dồn vào batchData
        const b = batchRowMap[batchKey];
        if (b.expiry && b.expiry !== 'N/A' && exp && exp !== 'N/A' && b.expiry.slice(0, 10) !== exp.slice(0, 10)) {
          throw new Error(`Lot Conflict for SKU [${sku}], Lot [${lot}]: Existing expiry date is [${b.expiry.slice(0, 10)}], imported date is [${exp.slice(0, 10)}].`);
        }
        b.qtyIn += qty;
        const newStock = b.qtyIn - b.qtyOut;

        if (b.dataRowIdx >= 0) {
          batchData[b.dataRowIdx][bInCol] = b.qtyIn;
          batchData[b.dataRowIdx][bStockCol] = newStock;
          if (bStorageCol !== -1 && itemInfo.storage) {
            batchData[b.dataRowIdx][bStorageCol] = itemInfo.storage;
          }
          existingBatchesModified = true;
        } else if (b.newBatchRef) {
          b.newBatchRef.QtyIn = b.qtyIn;
          b.newBatchRef.CurrentStock = newStock;
        }
      } else {
        // Lô mới -> tích lũy vào newBatchesToAppend
        const newBatch = {
          BatchKey: batchKey,
          ItemCode: sku,
          ItemName: itemInfo.name,
          LotNumber: lot,
          ExpiryDate: exp,
          QtyIn: qty,
          QtyOut: 0,
          CurrentStock: qty,
          Status: 'Active',
          Storage: itemInfo.storage || ''
        };
        newBatchesToAppend.push(newBatch);
        batchRowMap[batchKey] = {
          rowIdx: batchData.length + newBatchesToAppend.length,
          dataRowIdx: -1,
          newBatchRef: newBatch,
          expiry: exp,
          qtyIn: qty,
          qtyOut: 0
        };
      }

      // Tạo bản ghi giao dịch
      const txId = `TX-INIT-${datePrefix}-${String(idx + 1).padStart(3, '0')}`;
      const txRecord = {
        TxID: txId,
        Timestamp: timestampStr,
        Type: 'IN',
        ItemCode: sku,
        ItemName: itemInfo.name,
        LotNumber: lot,
        ExpiryDate: exp,
        Qty: qty,
        Unit: itemInfo.unit,
        Note: finalNote,
        Operator: operator,
        Status: 'ACTIVE',
        RefTxID: 'BULK_INIT',
        VoidReason: ''
      };
      newTxToAppend.push(txRecord);
    });

    // 5. GHI HÀNG LOẠT (BATCH WRITE - CHỈ 1-2 API CALLS THAY VÌ HÀNG TRĂM CALLS)
    if (existingBatchesModified && batchData.length > 1) {
      batchSheet.getRange(2, 1, batchData.length - 1, batchData[0].length).setValues(batchData.slice(1));
    }
    if (newBatchesToAppend.length > 0) {
      appendRowsByHeaders(batchSheet, newBatchesToAppend);
    }
    if (newTxToAppend.length > 0) {
      appendRowsByHeaders(txSheet, newTxToAppend);
    }

    return { success: true, count: records.length, appData: getInitialAppData(ss) };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}