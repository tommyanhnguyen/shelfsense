const { randomUUID } = require('node:crypto');
const config = require('../shared/config');
const { createEvent, getSku, validateEvent } = require('../shared/events');

const CASE_SIZE = 6;

function createReplenishmentService(options) {
  const { store, publish } = options;
  const autoApproveUnder = options.autoApproveUnder ?? config.autoApproveUnder;
  const safetyDays = options.safetyDays ?? config.safetyDays;
  const idFactory = options.idFactory || randomUUID;
  const now = options.now || Date.now;

  async function handleStockUpdated(event) {
    validateEvent(event);
    if (event.type !== 'stock.updated') throw new Error('Replenishment expects stock.updated');

    const row = event.data;
    if (row.velocityPerDay <= 0 || row.daysToStockout === null) return null;

    const item = getSku(row.skuId);
    if (row.daysToStockout >= item.leadTimeDays + safetyDays) return null;
    if (await store.findOpenOrder(event.store, row.skuId)) return null;

    const target = row.velocityPerDay * (item.leadTimeDays + safetyDays);
    const needed = Math.max(0, Math.ceil(target - Math.max(row.qty, 0)));
    if (needed === 0) return null;

    const qty = Math.ceil(needed / CASE_SIZE) * CASE_SIZE;
    const value = Number((qty * item.price).toFixed(2));
    const automatic = value < autoApproveUnder;
    const order = {
      orderId: idFactory(),
      store: event.store,
      openKey: event.store + '/' + row.skuId,
      supplier: item.supplier,
      lines: [{ skuId: row.skuId, qty, unitPrice: item.price }],
      value,
      status: automatic ? 'APPROVED' : 'PENDING_APPROVAL',
      approvedBy: automatic ? 'auto-rule' : null,
      createdAt: now()
    };

    try {
      await store.saveOrder(order);
    } catch (error) {
      if (error.code === 11000) return store.findOpenOrder(event.store, row.skuId);
      throw error;
    }
    await publish(createEvent('order.created', order.store, order, { ts: event.ts }));
    if (automatic) {
      await publish(createEvent('order.approved', order.store, {
        orderId: order.orderId,
        approvedBy: order.approvedBy
      }, { ts: event.ts }));
    }
    return order;
  }

  async function approve(orderId, approvedBy) {
    const current = await store.getOrder(orderId);
    if (!current) throw new Error('Unknown order: ' + orderId);
    if (!['PENDING_APPROVAL', 'APPROVED'].includes(current.status)) return current;
    const event = createEvent('order.approved', current.store, {
      orderId: current.orderId,
      approvedBy
    }, { eventId: 'order-approved-' + current.orderId });
    const result = store.approveOrderWithPendingEvent
      ? await store.approveOrderWithPendingEvent(orderId, approvedBy, now(), event)
      : { order: await store.approveOrder(orderId, approvedBy, now()), event };
    if (!result.event) return result.order;
    await publish(result.event);
    if (store.markApprovalPublished) await store.markApprovalPublished(result.event.eventId);
    return result.order;
  }

  return { approve, handleStockUpdated };
}

module.exports = { CASE_SIZE, createReplenishmentService };
