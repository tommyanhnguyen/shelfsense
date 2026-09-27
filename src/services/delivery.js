const { randomUUID } = require('node:crypto');
const { createEvent, validateEvent } = require('../shared/events');

// Stores, depots and routing
const STORES = {
  'store-01': { store: 'store-01', region: 'melbourne-east', x: 3, y: 4 },
  'store-02': { store: 'store-02', region: 'melbourne-east', x: 6, y: 8 },
  'store-03': { store: 'store-03', region: 'melbourne-west', x: 4, y: 3 },
  'store-04': { store: 'store-04', region: 'melbourne-west', x: 8, y: 6 }
};

const DEPOTS = {
  'Dairy Distribution Centre': { x: 0, y: 0 },
  'Dry Goods Distribution Centre': { x: 1, y: 1 }
};

function getStore(store) {
  if (!Object.hasOwn(STORES, store)) throw new Error('Unknown store: ' + store);
  return { ...STORES[store] };
}

function getDepot(supplier) {
  if (!Object.hasOwn(DEPOTS, supplier)) throw new Error('Unknown supplier: ' + supplier);
  return { ...DEPOTS[supplier] };
}

function batchKey(order) {
  return encodeURIComponent(order.supplier) + ':' + getStore(order.store).region;
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function nearestNeighbour(start, stops) {
  const pending = stops.map(stop => ({ ...stop }));
  const route = [];
  let current = start;
  while (pending.length) {
    pending.sort((a, b) => distance(current, a) - distance(current, b) || a.id.localeCompare(b.id));
    current = pending.shift();
    route.push(current);
  }
  return route;
}

function routeWithEtas(start, stops, speedKmPerHour, startedAt) {
  if (!Number.isFinite(speedKmPerHour) || speedKmPerHour <= 0) throw new Error('Speed must be positive');
  let current = start;
  let elapsedMs = 0;
  return nearestNeighbour(start, stops).map(stop => {
    const distanceKm = distance(current, stop);
    elapsedMs += distanceKm / speedKmPerHour * 60 * 60 * 1000;
    current = stop;
    return { ...stop, distanceKm: Number(distanceKm.toFixed(2)), eta: Math.round(startedAt + elapsedMs) };
  });
}

// Delivery service

function createDeliveryService(options) {
  const { store, publish } = options;
  const idFactory = options.idFactory || randomUUID;
  const now = options.now || Date.now;
  const speedKmPerHour = options.speedKmPerHour || 40;

  async function handle(event) {
    validateEvent(event);
    if (event.type !== 'order.approved') throw new Error('Delivery expects order.approved');
    const order = await store.getOrder(event.data.orderId);
    if (!order) throw new Error('Unknown order: ' + event.data.orderId);
    const storeInfo = getStore(order.store);
    const candidate = {
      deliveryId: idFactory(),
      batchKey: batchKey(order),
      supplier: order.supplier,
      region: storeInfo.region,
      orderIds: [],
      stores: [],
      route: [],
      stops: [],
      status: 'DRAFT',
      createdAt: now()
    };
    const delivery = await store.addOrderToDeliveryBatch(order, candidate);
    if (order.status !== 'IN_DELIVERY') {
      order.status = 'IN_DELIVERY';
      await store.saveOrder(order);
    }
    if (delivery.orderIds.length === 1) {
      await publish(createEvent('delivery.created', order.store, delivery, { ts: event.ts }));
    }
    return delivery;
  }

  async function dispatch(deliveryId) {
    const current = await store.getDelivery(deliveryId);
    if (!current) throw new Error('Unknown delivery: ' + deliveryId);
    if (current.status !== 'DRAFT') return current;
    const orders = await Promise.all(current.orderIds.map(orderId => store.getOrder(orderId)));
    if (orders.some(order => !order)) throw new Error('Delivery contains an unknown order');
    const orderIdsByStore = new Map();
    for (const order of orders) {
      const ids = orderIdsByStore.get(order.store) || [];
      ids.push(order.orderId);
      orderIdsByStore.set(order.store, ids);
    }
    const points = [...orderIdsByStore.keys()].map(storeId => {
      const info = getStore(storeId);
      return { id: storeId, x: info.x, y: info.y };
    });
    const plannedAt = now();
    const routed = routeWithEtas(getDepot(current.supplier), points, speedKmPerHour, plannedAt);
    const delivery = await store.dispatchDelivery(deliveryId, {
      status: 'PLANNED',
      plannedAt,
      route: routed.map(stop => stop.id),
      stops: routed.map(stop => ({
        store: stop.id,
        orderIds: orderIdsByStore.get(stop.id),
        distanceKm: stop.distanceKm,
        eta: stop.eta,
        status: 'PENDING'
      }))
    });
    await publish(createEvent('delivery.status', delivery.region, {
      deliveryId, status: delivery.status
    }, { eventId: 'delivery-status-' + deliveryId + '-planned' }));
    return delivery;
  }

  async function start(deliveryId) {
    const delivery = await store.startDelivery(deliveryId, now());
    if (!delivery) throw new Error('Delivery is not ready to start: ' + deliveryId);
    await publish(createEvent('delivery.status', delivery.region, {
      deliveryId, status: delivery.status
    }, { eventId: 'delivery-status-' + deliveryId + '-in-transit' }));
    return delivery;
  }

  async function completeStop(deliveryId, storeId) {
    const delivery = await store.getDelivery(deliveryId);
    if (!delivery) throw new Error('Unknown delivery: ' + deliveryId);
    if (!['IN_TRANSIT', 'DELIVERED'].includes(delivery.status)) {
      throw new Error('Delivery is not in transit: ' + deliveryId);
    }
    const stop = delivery.stops.find(item => item.store === storeId);
    if (!stop) throw new Error('Unknown delivery stop: ' + storeId);
    if (stop.status === 'DELIVERED') return delivery;
    stop.status = 'RESTOCK_PENDING';
    stop.arrivedAt = stop.arrivedAt || now();
    await store.saveDelivery(delivery);
    for (const orderId of stop.orderIds) {
      const order = await store.getOrder(orderId);
      if (!order) throw new Error('Unknown order: ' + orderId);
      for (const line of order.lines) {
        await publish(createEvent('stock.delta', order.store, {
          skuId: line.skuId,
          delta: line.qty,
          source: 'delivery',
          deliveryId,
          orderId,
          wallTs: Date.now()
        }, { eventId: ['delivery', deliveryId, orderId, line.skuId].join('-') }));
      }
      await store.closeOrder(orderId, 'DELIVERED', stop.arrivedAt);
    }
    stop.status = 'DELIVERED';
    stop.deliveredAt = stop.arrivedAt;
    if (delivery.stops.every(item => item.status === 'DELIVERED')) {
      delivery.status = 'DELIVERED';
      delivery.deliveredAt = Math.max(...delivery.stops.map(item => item.deliveredAt));
    }
    await store.saveDelivery(delivery);
    await publish(createEvent('delivery.status', storeId, {
      deliveryId, status: delivery.status, stop: storeId
    }, { eventId: 'delivery-status-' + deliveryId + '-' + storeId + '-delivered' }));
    return delivery;
  }

  async function completeLegacy(delivery) {
    if (delivery.status === 'DELIVERED') return delivery;
    const order = await store.getOrder(delivery.orderId);
    if (!order) throw new Error('Unknown order: ' + delivery.orderId);
    if (delivery.status === 'PLANNED') {
      delivery.status = 'RESTOCK_PENDING';
      delivery.deliveredAt = now();
      await store.saveDelivery(delivery);
    }
    for (const line of order.lines) {
      await publish(createEvent('stock.delta', delivery.store, {
        skuId: line.skuId, delta: line.qty, source: 'delivery', deliveryId: delivery.deliveryId, wallTs: Date.now()
      }, { eventId: 'delivery-' + delivery.deliveryId + '-' + line.skuId }));
    }
    await store.closeOrder(delivery.orderId, 'DELIVERED', delivery.deliveredAt);
    delivery.status = 'DELIVERED';
    await store.saveDelivery(delivery);
    return delivery;
  }

  async function complete(deliveryId) {
    let delivery = await store.getDelivery(deliveryId);
    if (!delivery) throw new Error('Unknown delivery: ' + deliveryId);
    if (delivery.orderId && !delivery.orderIds) return completeLegacy(delivery);
    if (delivery.status === 'DRAFT') delivery = await dispatch(deliveryId);
    if (delivery.status === 'PLANNED') delivery = await start(deliveryId);
    for (const stop of delivery.stops) delivery = await completeStop(deliveryId, stop.store);
    return delivery;
  }

  return { complete, completeStop, dispatch, handle, start };
}

module.exports = { DEPOTS, STORES, batchKey, createDeliveryService, distance, getDepot, getStore, nearestNeighbour, routeWithEtas };
