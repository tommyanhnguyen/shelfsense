const { isOpenOrder, newStockRow, stockKey } = require('../src/shared/store');

class MemoryStore {
  constructor() {
    this.stockEvents = new Map();
    this.stockApplications = new Set();
    this.stock = new Map();
    this.orders = new Map();
    this.alerts = new Map();
    this.deliveries = new Map();
    this.deadLetters = [];
  }

  async recordStockEvent(event) {
    if (this.stockEvents.has(event.eventId)) return { duplicate: true };
    this.stockEvents.set(event.eventId, structuredClone(event));
    return { duplicate: false };
  }

  async beginStockEvent(event) {
    const existing = this.stockEvents.get(event.eventId);
    if (existing) return { duplicate: true, complete: existing.status !== 'PROCESSING' };
    this.stockEvents.set(event.eventId, { event: structuredClone(event), status: 'PROCESSING' });
    return { duplicate: false, complete: false };
  }

  async completeStockEvent(eventId) {
    const record = this.stockEvents.get(eventId);
    if (!record) throw new Error('Unknown stock event: ' + eventId);
    if (record.event) {
      record.status = 'APPLIED';
      record.appliedAt = Date.now();
    }
    return true;
  }

  async countAppliedSince(since) {
    return [...this.stockEvents.values()].filter(record => record.appliedAt >= since).length;
  }

  async saveScalerDecision(row) {
    this.scalerLog = [...(this.scalerLog || []), structuredClone(row)];
    return row;
  }

  async applyPhysicalDelta(event) {
    const { skuId, delta } = event.data;
    const key = stockKey(event.store, skuId);
    const row = this.stock.get(key) || newStockRow(event.store, skuId);
    if (!this.stockApplications.has(event.eventId)) {
      row.qty += delta;
      this.stockApplications.add(event.eventId);
    }
    row.updatedAt = event.ts;
    this.stock.set(key, row);
    return structuredClone(row);
  }

  async recordSale(event) {
    const { skuId, delta } = event.data;
    const key = stockKey(event.store, skuId);
    const row = this.stock.get(key) || newStockRow(event.store, skuId);
    if (!this.stockApplications.has(event.eventId)) {
      row.soldUnits += Math.abs(delta);
      row.saleCount += 1;
      row.firstSaleTs = row.firstSaleTs === null ? event.ts : Math.min(row.firstSaleTs, event.ts);
      row.lastSaleTs = row.lastSaleTs === null ? event.ts : Math.max(row.lastSaleTs, event.ts);
      this.stockApplications.add(event.eventId);
    }
    row.updatedAt = event.ts;
    this.stock.set(key, row);
    return structuredClone(row);
  }

  async getStock(store, skuId) {
    const row = this.stock.get(stockKey(store, skuId));
    return row ? structuredClone(row) : null;
  }

  async saveStock(row) {
    this.stock.set(stockKey(row.store, row.skuId), structuredClone(row));
    return structuredClone(row);
  }

  async listStock() {
    return [...this.stock.values()].map(row => structuredClone(row));
  }

  async saveOrder(order) {
    if (order.openKey && isOpenOrder(order)) {
      const existing = [...this.orders.values()].find(item =>
        item.openKey === order.openKey && item.orderId !== order.orderId && isOpenOrder(item)
      );
      if (existing) {
        const error = new Error('Duplicate open order');
        error.code = 11000;
        throw error;
      }
    }
    this.orders.set(order.orderId, structuredClone(order));
    return structuredClone(order);
  }

  async getOrder(orderId) {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : null;
  }

  async findOpenOrder(store, skuId) {
    const order = [...this.orders.values()].find(item =>
      item.store === store && isOpenOrder(item) && item.lines.some(line => line.skuId === skuId)
    );
    return order ? structuredClone(order) : null;
  }

  async closeOrder(orderId, status = 'DELIVERED', closedAt = Date.now()) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    order.status = status;
    order.closedAt = closedAt;
    delete order.openKey;
    return structuredClone(order);
  }

  async approveOrder(orderId, approvedBy, approvedAt = Date.now()) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (order.status === 'PENDING_APPROVAL') {
      order.status = 'APPROVED';
      order.approvedBy = approvedBy;
      order.approvedAt = approvedAt;
    }
    return structuredClone(order);
  }

  async approveOrderWithPendingEvent(orderId, approvedBy, approvedAt, event) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (order.status === 'PENDING_APPROVAL') {
      order.status = 'APPROVED';
      order.approvedBy = approvedBy;
      order.approvedAt = approvedAt;
      order.pendingApprovalEvent = structuredClone(event);
    }
    return { order: structuredClone(order), event: structuredClone(order.pendingApprovalEvent || null) };
  }

  async listPendingApprovalEvents() {
    return [...this.orders.values()].filter(order => order.pendingApprovalEvent)
      .map(order => structuredClone(order.pendingApprovalEvent));
  }

  async markApprovalPublished(eventId) {
    const order = [...this.orders.values()].find(item => item.pendingApprovalEvent?.eventId === eventId);
    if (order) delete order.pendingApprovalEvent;
    return Boolean(order);
  }

  async listOrders() {
    return [...this.orders.values()].map(order => structuredClone(order));
  }

  async saveAlert(alert) {
    if (!this.alerts.has(alert.eventId)) {
      this.alerts.set(alert.eventId, structuredClone({ ...alert, receivedAt: Date.now() }));
    }
    return structuredClone(this.alerts.get(alert.eventId));
  }

  async listAlerts() {
    return [...this.alerts.values()].map(alert => structuredClone(alert));
  }

  async saveDelivery(delivery) {
    this.deliveries.set(delivery.deliveryId, structuredClone(delivery));
    return structuredClone(delivery);
  }

  async addOrderToDeliveryBatch(order, candidate) {
    const assigned = [...this.deliveries.values()].find(item => item.orderIds?.includes(order.orderId));
    if (assigned) return structuredClone(assigned);
    let delivery = [...this.deliveries.values()].find(item =>
      item.batchKey === candidate.batchKey && item.status === 'DRAFT'
    );
    if (!delivery) delivery = structuredClone(candidate);
    if (!delivery.orderIds.includes(order.orderId)) delivery.orderIds.push(order.orderId);
    if (!delivery.stores.includes(order.store)) delivery.stores.push(order.store);
    this.deliveries.set(delivery.deliveryId, delivery);
    return structuredClone(delivery);
  }

  async dispatchDelivery(deliveryId, update) {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) return null;
    if (delivery.status !== 'DRAFT') return structuredClone(delivery);
    Object.assign(delivery, structuredClone(update));
    return structuredClone(delivery);
  }

  async startDelivery(deliveryId, startedAt) {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || !['PLANNED', 'IN_TRANSIT'].includes(delivery.status)) return null;
    if (delivery.status === 'PLANNED') {
      delivery.status = 'IN_TRANSIT';
      delivery.startedAt = startedAt;
    }
    return structuredClone(delivery);
  }

  async getDelivery(deliveryId) {
    const delivery = this.deliveries.get(deliveryId);
    return delivery ? structuredClone(delivery) : null;
  }

  async listDeliveries() {
    return [...this.deliveries.values()].map(delivery => structuredClone(delivery));
  }

  async saveDeadLetter(item) {
    this.deadLetters.push(structuredClone(item));
    return structuredClone(item);
  }

  async listDeadLetters() {
    return this.deadLetters.map(item => structuredClone(item));
  }

  async close() {}

  isReady() { return true; }
}

module.exports = { MemoryStore };
