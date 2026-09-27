const containers = {
  stock: document.querySelector('#stock'),
  orders: document.querySelector('#orders'),
  alerts: document.querySelector('#alerts'),
  deliveries: document.querySelector('#deliveries')
};
const status = document.querySelector('#status');
let accessToken = '';

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(accessToken ? { authorization: 'Bearer ' + accessToken } : {})
    }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function card(lines, action = '') {
  return `<article class="card">${lines.map(line => `<div>${line}</div>`).join('')}${action}</article>`;
}

async function approve(orderId) {
  await apiFetch(`/api/orders/${encodeURIComponent(orderId)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvedBy: 'manager:tommy' })
  });
  await loadData();
}

async function deliveryAction(deliveryId, action, store = '') {
  const suffix = action === 'stop'
    ? `/stops/${encodeURIComponent(store)}/complete`
    : `/${action}`;
  await apiFetch(`/api/deliveries/${encodeURIComponent(deliveryId)}${suffix}`, { method: 'POST' });
  await loadData();
}

async function loadData() {
  status.textContent = 'Loading...';
  try {
    const [stock, orders, alerts, deliveries] = await Promise.all(
      ['stock', 'orders', 'alerts', 'deliveries'].map(name => apiFetch('/api/' + name))
    );

    containers.stock.innerHTML = stock.map(row => card([
      `<strong>${escapeHtml(row.store)} · ${escapeHtml(row.skuId)}</strong>`,
      `Quantity: ${escapeHtml(row.qty)}`,
      `Velocity: ${escapeHtml(row.velocityPerDay || 0)} per day`
    ])).join('') || '<p>No stock data.</p>';

    const pending = orders.filter(order => order.status === 'PENDING_APPROVAL');
    containers.orders.innerHTML = pending.map(order => card([
      `<strong>${escapeHtml(order.orderId)}</strong>`,
      `${escapeHtml(order.store)} · $${escapeHtml(order.value)}`
    ], `<button data-order="${escapeHtml(order.orderId)}">Approve</button>`)).join('') || '<p>No pending orders.</p>';

    containers.alerts.innerHTML = alerts.map(alert => card([
      `<strong>${escapeHtml(alert.store)} · ${escapeHtml(alert.data.unitId)}</strong>`,
      `${escapeHtml(alert.data.state)} at ${escapeHtml(alert.data.tempC)}°C`
    ])).join('') || '<p>No cold-chain alerts.</p>';

    containers.deliveries.innerHTML = deliveries.map(delivery => card([
      `<strong>${escapeHtml(delivery.deliveryId)}</strong>`,
      `${escapeHtml(delivery.region || delivery.store)} · ${escapeHtml(delivery.status)}`,
      delivery.route?.length ? `Route: ${delivery.route.map(escapeHtml).join(' → ')}` : 'Route not dispatched',
      ...(delivery.stops || []).map(stop => `${escapeHtml(stop.store)} · ${escapeHtml(stop.status)} · ETA ${new Date(stop.eta).toLocaleTimeString()}`)
    ], delivery.status === 'DRAFT'
      ? `<button data-delivery="${escapeHtml(delivery.deliveryId)}" data-action="dispatch">Dispatch batch</button>`
      : delivery.status === 'PLANNED'
        ? `<button data-delivery="${escapeHtml(delivery.deliveryId)}" data-action="start">Start route</button>`
        : delivery.status === 'IN_TRANSIT'
          ? (delivery.stops || []).filter(stop => stop.status !== 'DELIVERED').map(stop =>
            `<button data-delivery="${escapeHtml(delivery.deliveryId)}" data-action="stop" data-store="${escapeHtml(stop.store)}">Complete ${escapeHtml(stop.store)}</button>`
          ).join('')
          : '')).join('') || '<p>No deliveries.</p>';

    status.textContent = 'Data updated.';
  } catch (error) {
    status.textContent = error.message;
  }
}

containers.orders.addEventListener('click', event => {
  const orderId = event.target.dataset.order;
  if (orderId) approve(orderId).catch(error => { status.textContent = error.message; });
});
containers.deliveries.addEventListener('click', event => {
  const deliveryId = event.target.dataset.delivery;
  if (deliveryId) deliveryAction(deliveryId, event.target.dataset.action, event.target.dataset.store)
    .catch(error => { status.textContent = error.message; });
});
document.querySelector('#refresh').addEventListener('click', loadData);
document.querySelector('#use-token').addEventListener('click', () => {
  const input = document.querySelector('#auth-token');
  accessToken = input.value.trim();
  input.value = '';
  loadData();
});
loadData();
