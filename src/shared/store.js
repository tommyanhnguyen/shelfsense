const OPEN_ORDER_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'IN_DELIVERY'];
const OPEN_ORDER_INDEX = 'open_order_unique';

function isOpenOrder(order) {
  return Boolean(order) && OPEN_ORDER_STATUSES.includes(order.status);
}

function stockKey(store, skuId) {
  return store + '/' + skuId;
}

function newStockRow(store, skuId) {
  return {
    store,
    skuId,
    qty: 0,
    soldUnits: 0,
    saleCount: 0,
    firstSaleTs: null,
    lastSaleTs: null,
    velocityPerDay: 0,
    daysToStockout: null,
    updatedAt: null
  };
}

class MongoStore {
  constructor(uri) {
    this.uri = uri;
    this.connection = null;
  }

  static async connect(uri) {
    const store = new MongoStore(uri);
    await store.connect();
    return store;
  }

  async connect() {
    const mongoose = require('mongoose');
    this.connection = await mongoose.createConnection(this.uri, {
      serverSelectionTimeoutMS: 8000
    }).asPromise();
    this.db = this.connection.db;
    await Promise.all([
      this.db.collection('stock_events').createIndex({ eventId: 1 }, { unique: true }),
      this.db.collection('stock_events').createIndex({ 'event.data.runId': 1, status: 1 }),
      this.db.collection('stock_levels').createIndex({ store: 1, skuId: 1 }, { unique: true }),
      this.db.collection('orders').createIndex({ orderId: 1 }, { unique: true }),
      this.db.collection('coldchain').createIndex({ eventId: 1 }, { unique: true }),
      this.db.collection('coldchain').createIndex({ 'data.runId': 1 }),
      this.db.collection('deliveries').createIndex({ deliveryId: 1 }, { unique: true }),
      this.db.collection('deliveries').createIndex({ orderIds: 1 }, {
        name: 'delivery_order_unique', unique: true,
        partialFilterExpression: { orderIds: { $type: 'array' } }
      }),
      this.db.collection('deliveries').createIndex({ batchKey: 1 }, {
        name: 'open_delivery_batch_unique', unique: true,
        partialFilterExpression: { batchKey: { $type: 'string' }, status: 'DRAFT' }
      })
    ]);
    await this.ensureOpenOrderIndex();
    return this;
  }

  async ensureOpenOrderIndex() {
    const orders = this.db.collection('orders');
    const existing = await orders.indexes();
    const dropIfPresent = async name => {
      try {
        await orders.dropIndex(name);
      } catch (error) {
        if (error.code !== 27) throw error;
      }
    };

    for (const index of existing) {
      if (index.key?.openKey === 1 && index.name !== OPEN_ORDER_INDEX) {
        await dropIfPresent(index.name);
      }
    }

    const options = {
      name: OPEN_ORDER_INDEX,
      unique: true,
      partialFilterExpression: {
        openKey: { $type: 'string' },
        status: { $in: OPEN_ORDER_STATUSES }
      }
    };

    try {
      await orders.createIndex({ openKey: 1 }, options);
    } catch (error) {
      if (error.code !== 85 && error.code !== 86) throw error;
      await dropIfPresent(OPEN_ORDER_INDEX);
      await orders.createIndex({ openKey: 1 }, options);
    }
    return OPEN_ORDER_INDEX;
  }

  async recordStockEvent(event) {
    try {
      await this.db.collection('stock_events').insertOne(event);
      return { duplicate: false };
    } catch (error) {
      if (error.code === 11000) return { duplicate: true };
      throw error;
    }
  }

  async beginStockEvent(event) {
    try {
      await this.db.collection('stock_events').insertOne({
        eventId: event.eventId,
        event,
        status: 'PROCESSING',
        createdAt: Date.now()
      });
      return { duplicate: false, complete: false };
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await this.db.collection('stock_events').findOne(
        { eventId: event.eventId }, { projection: { status: 1 } }
      );
      return { duplicate: true, complete: existing?.status === 'APPLIED' };
    }
  }

  async completeStockEvent(eventId) {
    await this.db.collection('stock_events').updateOne(
      { eventId }, { $set: { status: 'APPLIED', appliedAt: Date.now() } }
    );
    return true;
  }

  async applyPhysicalDelta(event) {
    const { skuId, delta } = event.data;
    const eventIds = { $ifNull: ['$appliedEventIds', []] };
    const alreadyApplied = { $in: [event.eventId, eventIds] };
    await this.db.collection('stock_levels').updateOne(
      { store: event.store, skuId },
      [
        {
          $set: {
            store: event.store,
            skuId,
            qty: { $cond: [alreadyApplied, { $ifNull: ['$qty', 0] }, { $add: [{ $ifNull: ['$qty', 0] }, delta] }] },
            soldUnits: { $ifNull: ['$soldUnits', 0] },
            saleCount: { $ifNull: ['$saleCount', 0] },
            firstSaleTs: { $ifNull: ['$firstSaleTs', null] },
            lastSaleTs: { $ifNull: ['$lastSaleTs', null] },
            velocityPerDay: { $ifNull: ['$velocityPerDay', 0] },
            daysToStockout: { $ifNull: ['$daysToStockout', null] },
            updatedAt: { $cond: [alreadyApplied, { $ifNull: ['$updatedAt', null] }, event.ts] },
            appliedEventIds: { $setUnion: [eventIds, [event.eventId]] }
          }
        }
      ],
      { upsert: true }
    );
    return this.getStock(event.store, skuId);
  }

  async recordSale(event) {
    const { skuId, delta } = event.data;
    const sold = Math.abs(delta);
    const eventIds = { $ifNull: ['$appliedEventIds', []] };
    const alreadyApplied = { $in: [event.eventId, eventIds] };
    await this.db.collection('stock_levels').updateOne(
      { store: event.store, skuId },
      [
        {
          $set: {
            store: event.store,
            skuId,
            qty: { $ifNull: ['$qty', 0] },
            soldUnits: { $cond: [alreadyApplied, { $ifNull: ['$soldUnits', 0] }, { $add: [{ $ifNull: ['$soldUnits', 0] }, sold] }] },
            saleCount: { $cond: [alreadyApplied, { $ifNull: ['$saleCount', 0] }, { $add: [{ $ifNull: ['$saleCount', 0] }, 1] }] },
            firstSaleTs: { $cond: [alreadyApplied, { $ifNull: ['$firstSaleTs', null] }, { $cond: [{ $eq: [{ $ifNull: ['$firstSaleTs', null] }, null] }, event.ts, { $min: ['$firstSaleTs', event.ts] }] }] },
            lastSaleTs: { $cond: [alreadyApplied, { $ifNull: ['$lastSaleTs', null] }, { $cond: [{ $eq: [{ $ifNull: ['$lastSaleTs', null] }, null] }, event.ts, { $max: ['$lastSaleTs', event.ts] }] }] },
            velocityPerDay: { $ifNull: ['$velocityPerDay', 0] },
            daysToStockout: { $ifNull: ['$daysToStockout', null] },
            updatedAt: { $cond: [alreadyApplied, { $ifNull: ['$updatedAt', null] }, event.ts] },
            appliedEventIds: { $setUnion: [eventIds, [event.eventId]] }
          }
        }
      ],
      { upsert: true }
    );
    return this.getStock(event.store, skuId);
  }

  async getStock(store, skuId) {
    return this.db.collection('stock_levels').findOne(
      { store, skuId }, { projection: { _id: 0, appliedEventIds: 0 } }
    );
  }

  async saveStock(row) {
    await this.db.collection('stock_levels').updateOne(
      { store: row.store, skuId: row.skuId },
      {
        $setOnInsert: {
          store: row.store,
          skuId: row.skuId,
          qty: row.qty ?? 0,
          soldUnits: row.soldUnits ?? 0,
          saleCount: row.saleCount ?? 0,
          firstSaleTs: row.firstSaleTs ?? null,
          lastSaleTs: row.lastSaleTs ?? null
        },
        $set: {
          velocityPerDay: row.velocityPerDay,
          daysToStockout: row.daysToStockout,
          updatedAt: row.updatedAt
        }
      },
      { upsert: true }
    );
    return row;
  }

  async listStock() {
    return this.db.collection('stock_levels').find({}, { projection: { _id: 0, appliedEventIds: 0 } }).toArray();
  }

  async saveOrder(order) {
    await this.db.collection('orders').updateOne({ orderId: order.orderId }, { $set: order }, { upsert: true });
    return order;
  }

  async getOrder(orderId) {
    return this.db.collection('orders').findOne({ orderId }, { projection: { _id: 0 } });
  }

  async findOpenOrder(store, skuId) {
    return this.db.collection('orders').findOne({
      openKey: stockKey(store, skuId),
      status: { $in: OPEN_ORDER_STATUSES }
    }, { projection: { _id: 0 } });
  }

  async approveOrder(orderId, approvedBy, approvedAt = Date.now()) {
    return this.db.collection('orders').findOneAndUpdate(
      { orderId, status: 'PENDING_APPROVAL' },
      { $set: { status: 'APPROVED', approvedBy, approvedAt } },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
  }

  async approveOrderWithPendingEvent(orderId, approvedBy, approvedAt, event) {
    const orders = this.db.collection('orders');
    let order = await orders.findOneAndUpdate(
      { orderId, status: 'PENDING_APPROVAL' },
      { $set: { status: 'APPROVED', approvedBy, approvedAt, pendingApprovalEvent: event } },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    if (!order) order = await orders.findOne({ orderId }, { projection: { _id: 0 } });
    if (!order) return null;
    return { order, event: order.pendingApprovalEvent || null };
  }

  async listPendingApprovalEvents() {
    const rows = await this.db.collection('orders').find(
      { pendingApprovalEvent: { $exists: true } }, { projection: { _id: 0, pendingApprovalEvent: 1 } }
    ).toArray();
    return rows.map(row => row.pendingApprovalEvent);
  }

  async markApprovalPublished(eventId) {
    const result = await this.db.collection('orders').updateOne(
      { 'pendingApprovalEvent.eventId': eventId }, { $unset: { pendingApprovalEvent: '' } }
    );
    return result.modifiedCount === 1;
  }

  async closeOrder(orderId, status = 'DELIVERED', closedAt = Date.now()) {
    return this.db.collection('orders').findOneAndUpdate(
      { orderId },
      { $set: { status, closedAt }, $unset: { openKey: '' } },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
  }

  async listOrders() {
    return this.db.collection('orders').find({}, { projection: { _id: 0 } }).toArray();
  }

  async saveAlert(alert) {
    await this.db.collection('coldchain').updateOne({ eventId: alert.eventId },
      { $setOnInsert: { ...alert, receivedAt: Date.now() } }, { upsert: true });
    return alert;
  }

  async listAlerts() {
    return this.db.collection('coldchain').find({}, { projection: { _id: 0 } }).toArray();
  }

  async saveDelivery(delivery) {
    await this.db.collection('deliveries').updateOne({ deliveryId: delivery.deliveryId }, { $set: delivery }, { upsert: true });
    return delivery;
  }

  async addOrderToDeliveryBatch(order, candidate) {
    const deliveries = this.db.collection('deliveries');
    const assigned = await deliveries.findOne({ orderIds: order.orderId }, { projection: { _id: 0 } });
    if (assigned) return assigned;
    try {
      return await deliveries.findOneAndUpdate(
        { batchKey: candidate.batchKey, status: 'DRAFT' },
        [{ $set: {
          deliveryId: { $ifNull: ['$deliveryId', candidate.deliveryId] },
          batchKey: { $ifNull: ['$batchKey', candidate.batchKey] },
          supplier: { $ifNull: ['$supplier', candidate.supplier] },
          region: { $ifNull: ['$region', candidate.region] },
          route: { $ifNull: ['$route', []] },
          stops: { $ifNull: ['$stops', []] },
          status: { $ifNull: ['$status', 'DRAFT'] },
          createdAt: { $ifNull: ['$createdAt', candidate.createdAt] },
          orderIds: { $setUnion: [{ $ifNull: ['$orderIds', []] }, [order.orderId]] },
          stores: { $setUnion: [{ $ifNull: ['$stores', []] }, [order.store]] }
        } }],
        { upsert: true, returnDocument: 'after', projection: { _id: 0 } }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      return deliveries.findOne({
        $or: [{ orderIds: order.orderId }, { batchKey: candidate.batchKey, status: 'DRAFT' }]
      }, { projection: { _id: 0 } });
    }
  }

  async dispatchDelivery(deliveryId, update) {
    const updated = await this.db.collection('deliveries').findOneAndUpdate(
      { deliveryId, status: 'DRAFT' }, { $set: update },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    return updated || this.getDelivery(deliveryId);
  }

  async startDelivery(deliveryId, startedAt) {
    const updated = await this.db.collection('deliveries').findOneAndUpdate(
      { deliveryId, status: 'PLANNED' }, { $set: { status: 'IN_TRANSIT', startedAt } },
      { returnDocument: 'after', projection: { _id: 0 } }
    );
    return updated || this.db.collection('deliveries').findOne(
      { deliveryId, status: 'IN_TRANSIT' }, { projection: { _id: 0 } }
    );
  }

  async getDelivery(deliveryId) {
    return this.db.collection('deliveries').findOne({ deliveryId }, { projection: { _id: 0 } });
  }

  async listDeliveries() {
    return this.db.collection('deliveries').find({}, { projection: { _id: 0 } }).toArray();
  }

  async saveDeadLetter(item) {
    await this.db.collection('dead_letters').insertOne(item);
    return item;
  }

  async listDeadLetters() {
    return this.db.collection('dead_letters').find({}, { projection: { _id: 0 } }).toArray();
  }

  async close() {
    if (this.connection) await this.connection.close();
  }

  isReady() { return this.connection?.readyState === 1; }
}

module.exports = {
  MongoStore,
  OPEN_ORDER_INDEX,
  OPEN_ORDER_STATUSES,
  isOpenOrder,
  newStockRow,
  stockKey
};
