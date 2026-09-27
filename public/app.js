'use strict';

// ShelfSense portal. Plain browser JavaScript, no build step.
// Sign-in: ./aws/setup.sh portal prints a link like /#manager=<token>&supplier=<token>&driver=<token>.
// The hash never reaches the server or the ALB logs; the page moves the tokens into sessionStorage
// (cleared when the tab closes) and removes them from the address bar.

const ROLES = ['manager', 'supplier', 'driver'];
const ROLE_LABEL = { manager: 'Manager', supplier: 'Supplier', driver: 'Driver' };
const HOME_TAB = { manager: 'orders', supplier: 'deliveries', driver: 'deliveries' };
const REFRESH_MS = 5000;
const STORAGE_KEY = 'shelfsense.session';
const PRODUCTS = { 'milk-1l': 'Fresh Milk 1L', 'yoghurt-500g': 'Natural Yoghurt 500g', 'rice-1kg': 'Rice 1kg' };
const ORDER_FILTERS = [
  ['PENDING_APPROVAL', 'Awaiting approval'],
  ['APPROVED', 'Approved'],
  ['IN_DELIVERY', 'In delivery'],
  ['DELIVERED', 'Delivered'],
  ['ALL', 'All']
];
const COLUMNS = [
  ['DRAFT', 'Waiting for dispatch', 'Supplier plans the route'],
  ['PLANNED', 'Ready to leave', 'Driver starts the route'],
  ['IN_TRANSIT', 'On the road', 'Driver confirms each stop'],
  ['DELIVERED', 'Delivered', 'Most recent first']
];
const STATUS_TEXT = {
  PENDING_APPROVAL: 'Awaiting approval', APPROVED: 'Approved', IN_DELIVERY: 'In delivery', DELIVERED: 'Delivered',
  DRAFT: 'Draft', PLANNED: 'Planned', IN_TRANSIT: 'On the road', PENDING: 'Pending', RESTOCK_PENDING: 'Restocking',
  BREACH: 'Breach', CLEARED: 'Cleared'
};

const state = {
  tokens: {},
  role: 'manager',
  localMode: false,
  tab: 'orders',
  orderFilter: 'PENDING_APPROVAL',
  stockQuery: '',
  stockStore: '',
  data: { stock: [], orders: [], alerts: [], deliveries: [] },
  signatures: {},
  updatedAt: 0,
  timer: null,
  busy: new Set()
};

const $ = selector => document.querySelector(selector);

// DOM helper: builds elements without innerHTML, so API data is never parsed as HTML.
function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'onclick') element.addEventListener('click', value);
    else if (key === 'text') element.textContent = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// Session

function readClaims(token) {
  try {
    const encoded = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(encoded));
  } catch {
    return null;
  }
}

function isLive(token) {
  const claims = readClaims(token);
  return Boolean(claims && ROLES.includes(claims.role) && claims.exp * 1000 > Date.now());
}

function saveSession() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ tokens: state.tokens, role: state.role }));
  } catch { /* private mode: the session lasts until reload */ }
}

function loadSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state.tokens = saved.tokens || {};
      if (ROLES.includes(saved.role)) state.role = saved.role;
    }
  } catch { /* ignore a broken entry */ }
}

function addToken(token) {
  const claims = readClaims(token);
  if (!claims || !ROLES.includes(claims.role)) return false;
  state.tokens[claims.role] = token;
  return true;
}

function readLinkTokens() {
  if (!location.hash.includes('=')) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  let added = false;
  for (const value of params.values()) added = addToken(value.trim()) || added;
  history.replaceState(null, '', location.pathname + location.search);
  return added;
}

function pruneTokens() {
  for (const role of ROLES) if (state.tokens[role] && !isLive(state.tokens[role])) delete state.tokens[role];
}

function signedInRoles() {
  return state.localMode ? ROLES : ROLES.filter(role => state.tokens[role]);
}

function scopeOf(role) {
  if (state.localMode) return '*';
  return readClaims(state.tokens[role] || '')?.stores ?? [];
}

function canAct(role, stores) {
  if (state.role !== role) return false;
  const scope = scopeOf(role);
  return scope === '*' || stores.every(store => scope.includes(store));
}

// API

async function api(path, options = {}) {
  const token = state.localMode ? '' : state.tokens[state.role];
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && !state.localMode) {
    delete state.tokens[state.role];
    saveSession();
    throw Object.assign(new Error('Your ' + ROLE_LABEL[state.role].toLowerCase() + ' session has expired'), { expired: true });
  }
  if (!response.ok) throw new Error(result.error || 'Request failed (' + response.status + ')');
  return result;
}

async function refresh({ quiet = true } = {}) {
  if (document.hidden && quiet) return;
  try {
    const names = ['stock', 'orders', 'alerts', 'deliveries'];
    const results = await Promise.all(names.map(name => api('/api/' + name)));
    names.forEach((name, index) => { state.data[name] = results[index]; });
    state.updatedAt = Date.now();
    render();
  } catch (error) {
    if (error.expired) return handleExpired(error.message);
    $('#updated').textContent = 'Offline: ' + error.message;
    document.body.classList.add('offline');
    if (!quiet) toast(error.message, 'error');
  }
}

function handleExpired(message) {
  pruneTokens();
  const next = signedInRoles()[0];
  if (next) {
    toast(message + '. Switched to ' + ROLE_LABEL[next] + '.', 'error');
    switchRole(next);
  } else {
    showSignin(message + '. Run ./aws/setup.sh portal for a new link.');
  }
}

async function act(key, label, path, body, patch) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    const result = await api(path, { method: 'POST', body });
    patch(result);
    toast(label, 'ok');
  } catch (error) {
    if (error.expired) handleExpired(error.message);
    else toast(error.message, 'error');
  } finally {
    state.busy.delete(key);
    state.signatures = {};
    render();
    setTimeout(() => refresh(), 800);
  }
}

function replaceRow(list, keyName, row) {
  const index = list.findIndex(item => item[keyName] === row[keyName]);
  if (index >= 0) list[index] = row; else list.push(row);
}

// Rendering. Each section is rebuilt only when its data or filters change, so the
// five-second refresh does not reset scroll positions or cause visible flicker.

function changed(name, value) {
  const signature = JSON.stringify(value);
  if (state.signatures[name] === signature) return false;
  state.signatures[name] = signature;
  return true;
}

function render() {
  const { stock, orders, alerts, deliveries } = state.data;
  const lowStock = stock.filter(row => row.daysToStockout !== null && row.daysToStockout !== undefined && row.daysToStockout < 3);
  const pending = orders.filter(order => order.status === 'PENDING_APPROVAL');
  const open = deliveries.filter(delivery => delivery.status !== 'DELIVERED');
  const breaches = latestAlerts(alerts).filter(alert => alert.data?.state === 'BREACH');

  $('#kpi-stock').textContent = lowStock.length;
  $('#kpi-orders').textContent = pending.length;
  $('#kpi-deliveries').textContent = open.length;
  $('#kpi-alerts').textContent = breaches.length;
  $('#kpi-alerts').closest('.kpi').classList.toggle('warn', breaches.length > 0);
  $('#kpi-orders').closest('.kpi').classList.toggle('attention', pending.length > 0);
  $('#count-stock').textContent = stock.length;
  $('#count-orders').textContent = orders.length;
  $('#count-deliveries').textContent = deliveries.length;
  $('#count-alerts').textContent = alerts.length;

  const view = [state.role, [...state.busy]];
  if (changed('stock', [stock, state.stockQuery, state.stockStore])) renderStock();
  if (changed('orders', [orders, state.orderFilter, view])) renderOrders();
  if (changed('deliveries', [deliveries, orders, view])) renderDeliveries();
  if (changed('alerts', alerts)) renderAlerts();
  renderChrome();
}

function renderChrome() {
  document.body.classList.remove('offline');
  for (const button of document.querySelectorAll('[data-role]')) {
    const role = button.dataset.role;
    const available = signedInRoles().includes(role);
    button.disabled = !available;
    button.title = available ? 'Act as ' + ROLE_LABEL[role] : 'No ' + ROLE_LABEL[role].toLowerCase() + ' token in this session';
    button.setAttribute('aria-pressed', String(role === state.role));
  }
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== state.tab;
  $('#signout').hidden = state.localMode;
  updateClock();
}

function updateClock() {
  if (!state.updatedAt || document.body.classList.contains('offline')) return;
  const seconds = Math.round((Date.now() - state.updatedAt) / 1000);
  $('#updated').textContent = (state.localMode ? 'Local mode · ' : 'Live · ') + (seconds < 2 ? 'just updated' : 'updated ' + seconds + 's ago');
}

function coverClass(days) {
  if (days === null || days === undefined) return 'none';
  if (days < 1.5) return 'critical';
  if (days < 3) return 'low';
  return 'ok';
}

function renderStock() {
  const stores = [...new Set(state.data.stock.map(row => row.store))].sort();
  const select = $('#stock-store');
  const chosen = state.stockStore;
  select.replaceChildren(h('option', { value: '' }, 'All stores'), ...stores.map(store => h('option', { value: store }, store)));
  select.value = stores.includes(chosen) ? chosen : '';

  const query = state.stockQuery.toLowerCase();
  const rows = state.data.stock
    .filter(row => !state.stockStore || row.store === state.stockStore)
    .filter(row => !query || [row.store, row.skuId, PRODUCTS[row.skuId]].join(' ').toLowerCase().includes(query))
    .sort((a, b) => (a.daysToStockout ?? Infinity) - (b.daysToStockout ?? Infinity) || a.store.localeCompare(b.store));
  const shown = rows.slice(0, 300);
  $('#stock-rows').replaceChildren(...shown.map(row => {
    const days = row.daysToStockout;
    const level = coverClass(days);
    const bar = h('span', { class: 'bar' }, h('span', { class: 'fill ' + level }));
    bar.firstChild.style.width = days === null || days === undefined ? '0%' : Math.min(100, days / 7 * 100) + '%';
    return h('tr', null,
      h('td', null, row.store),
      h('td', null, h('div', { class: 'product' }, PRODUCTS[row.skuId] || row.skuId), h('div', { class: 'sub' }, row.skuId)),
      h('td', { class: 'num strong' }, row.qty),
      h('td', { class: 'num' }, row.velocityPerDay ? row.velocityPerDay : '–'),
      h('td', null, h('div', { class: 'cover' }, bar,
        h('span', { class: 'cover-text ' + level }, days === null || days === undefined ? 'Not enough sales yet' : days + ' days')))
    );
  }));
  const empty = $('#stock-empty');
  empty.hidden = rows.length > 0 && rows.length <= 300;
  empty.textContent = rows.length === 0
    ? (state.data.stock.length ? 'No stock matches this search.' : 'No stock yet. Run ./aws/setup.sh demo to send shelf readings.')
    : 'Showing the 300 lowest of ' + rows.length + ' rows. Search to narrow the list.';
}

function orderLines(order) {
  return (order.lines || []).map(line => (line.qty ?? '') + ' × ' + (PRODUCTS[line.skuId] || line.skuId)).join(', ');
}

function pill(status) {
  return h('span', { class: 'pill ' + String(status).toLowerCase() }, STATUS_TEXT[status] || status);
}

function actionButton({ key, role, stores, label, run }) {
  const allowed = canAct(role, stores);
  if (allowed) {
    const busy = state.busy.has(key);
    return h('button', { type: 'button', class: busy ? 'busy' : null, disabled: busy, onclick: run }, busy ? 'Working…' : label);
  }
  const hasRole = signedInRoles().includes(role);
  const wrongStore = state.role === role;
  return h('div', { class: 'locked' },
    h('button', { type: 'button', disabled: true, title: label + ' is a ' + ROLE_LABEL[role].toLowerCase() + ' action' }, label),
    wrongStore
      ? h('span', { class: 'sub' }, 'Outside your stores')
      : hasRole
        ? h('button', { type: 'button', class: 'link', onclick: () => switchRole(role) }, 'Switch to ' + ROLE_LABEL[role])
        : h('span', { class: 'sub' }, ROLE_LABEL[role] + ' only'));
}

function renderOrders() {
  const orders = state.data.orders;
  const counts = Object.fromEntries(ORDER_FILTERS.map(([status]) =>
    [status, status === 'ALL' ? orders.length : orders.filter(order => order.status === status).length]));
  $('#order-filters').replaceChildren(...ORDER_FILTERS.map(([status, label]) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.orderFilter === status),
      onclick: () => { state.orderFilter = status; render(); } }, label, h('span', { class: 'count' }, counts[status]))));

  const rows = orders
    .filter(order => state.orderFilter === 'ALL' || order.status === state.orderFilter)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 200);
  const list = $('#order-list');
  if (!rows.length) {
    list.replaceChildren(h('div', { class: 'empty-state' },
      h('strong', null, state.orderFilter === 'PENDING_APPROVAL' ? 'Nothing waiting for approval' : 'No orders here'),
      h('p', null, state.orderFilter === 'PENDING_APPROVAL'
        ? 'Orders under $150 are approved automatically. A store also keeps only one open order per product, so a new order appears after the previous one is delivered.'
        : 'Orders appear when shelves run low. Run ./aws/setup.sh demo to create some.')));
    return;
  }
  list.replaceChildren(...rows.map(order => h('article', { class: 'row-card' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, h('strong', null, order.store), pill(order.status)),
      h('div', null, orderLines(order)),
      h('div', { class: 'sub' },
        (order.supplier || 'Supplier') + ' · created ' + ago(order.createdAt) + (order.approvedBy ? ' · approved by ' + order.approvedBy : ''))),
    h('div', { class: 'row-side' },
      h('div', { class: 'money' }, '$' + Number(order.value || 0).toFixed(2)),
      order.status === 'PENDING_APPROVAL' ? actionButton({
        key: 'approve:' + order.orderId, role: 'manager', stores: [order.store], label: 'Approve',
        run: () => act('approve:' + order.orderId, 'Order for ' + order.store + ' approved',
          '/api/orders/' + encodeURIComponent(order.orderId) + '/approve',
          { approvedBy: 'manager' }, result => replaceRow(state.data.orders, 'orderId', result))
      }) : null))));
}

function deliveryActions(delivery) {
  const stores = delivery.stores?.length ? delivery.stores : [delivery.store].filter(Boolean);
  const base = '/api/deliveries/' + encodeURIComponent(delivery.deliveryId);
  const patch = result => replaceRow(state.data.deliveries, 'deliveryId', result);
  if (delivery.status === 'DRAFT') {
    return [actionButton({ key: 'dispatch:' + delivery.deliveryId, role: 'supplier', stores, label: 'Plan route and dispatch',
      run: () => act('dispatch:' + delivery.deliveryId, 'Route planned for ' + stores.join(', '), base + '/dispatch', null, patch) })];
  }
  if (delivery.status === 'PLANNED') {
    return [actionButton({ key: 'start:' + delivery.deliveryId, role: 'driver', stores, label: 'Start route',
      run: () => act('start:' + delivery.deliveryId, 'Route started', base + '/start', null, patch) })];
  }
  if (delivery.status === 'IN_TRANSIT') {
    const next = (delivery.stops || []).find(stop => stop.status !== 'DELIVERED');
    if (!next) return [];
    return [actionButton({ key: 'stop:' + delivery.deliveryId, role: 'driver', stores: [next.store], label: 'Delivered to ' + next.store,
      run: () => act('stop:' + delivery.deliveryId, 'Delivered to ' + next.store + ', shelf restocked',
        base + '/stops/' + encodeURIComponent(next.store) + '/complete', null, patch) })];
  }
  return [];
}

function deliveryCard(delivery) {
  const stores = delivery.stores?.length ? delivery.stores : [delivery.store].filter(Boolean);
  const stops = delivery.stops || [];
  return h('article', { class: 'delivery' },
    h('div', { class: 'row-title' }, h('strong', null, delivery.region || stores.join(', ')), pill(delivery.status)),
    h('div', { class: 'sub' }, (delivery.supplier || 'Supplier') + ' · ' + (delivery.orderIds?.length || 1) + ' order' + ((delivery.orderIds?.length || 1) === 1 ? '' : 's')),
    stops.length
      ? h('ol', { class: 'stops' }, stops.map(stop => h('li', { class: stop.status === 'DELIVERED' ? 'done' : null },
        h('span', null, stop.store), h('span', { class: 'sub' },
          stop.status === 'DELIVERED' ? 'delivered ' + clock(stop.deliveredAt) : 'ETA ' + clock(stop.eta) + ' · ' + stop.distanceKm + ' km'))))
      : h('div', { class: 'tags' }, stores.map(store => h('span', { class: 'tag' }, store))),
    h('div', { class: 'actions' }, deliveryActions(delivery)));
}

function renderDeliveries() {
  const deliveries = state.data.deliveries;
  $('#board').replaceChildren(...COLUMNS.map(([status, title, note]) => {
    let items = deliveries.filter(delivery => status === 'DELIVERED'
      ? delivery.status === 'DELIVERED'
      : status === 'IN_TRANSIT' ? ['IN_TRANSIT', 'RESTOCK_PENDING'].includes(delivery.status) : delivery.status === status);
    items = items.sort((a, b) => status === 'DELIVERED'
      ? (b.deliveredAt || 0) - (a.deliveredAt || 0)
      : (a.createdAt || 0) - (b.createdAt || 0)).slice(0, 50);
    return h('section', { class: 'column' },
      h('header', null, h('div', null, h('strong', null, title), h('div', { class: 'sub' }, note)), h('span', { class: 'count' }, items.length)),
      h('div', { class: 'scroll column-body' }, items.length ? items.map(deliveryCard)
        : h('p', { class: 'empty' }, status === 'DRAFT' ? 'Approved orders are batched here by supplier and region.' : 'Nothing here.')));
  }));
}

function latestAlerts(alerts) {
  const byUnit = new Map();
  for (const alert of alerts) {
    const key = alert.store + '/' + alert.data?.unitId;
    if (!byUnit.has(key) || (byUnit.get(key).ts || 0) < (alert.ts || 0)) byUnit.set(key, alert);
  }
  return [...byUnit.values()];
}

function renderAlerts() {
  const alerts = [...state.data.alerts].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 200);
  const list = $('#alert-list');
  if (!alerts.length) {
    list.replaceChildren(h('div', { class: 'empty-state' }, h('strong', null, 'All fridges within limits'),
      h('p', null, 'A breach is raised after several readings above the limit, and cleared once the temperature is back below it.')));
    return;
  }
  list.replaceChildren(...alerts.map(alert => h('article', { class: 'row-card' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, h('strong', null, alert.store + ' · ' + (alert.data?.unitId || 'unit')), pill(alert.data?.state)),
      h('div', { class: 'sub' }, ago(alert.ts))),
    h('div', { class: 'row-side' }, h('div', { class: 'temp ' + (alert.data?.state === 'BREACH' ? 'hot' : '') }, alert.data?.tempC + ' °C')))));
}

// Formatting

function ago(ts) {
  if (!ts) return 'just now';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
  return new Date(ts).toLocaleDateString();
}

function clock(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–';
}

function toast(message, kind) {
  const item = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(item);
  setTimeout(() => item.classList.add('leaving'), 3600);
  setTimeout(() => item.remove(), 4000);
}

// Navigation

function switchRole(role) {
  if (!signedInRoles().includes(role)) return;
  state.role = role;
  state.tab = HOME_TAB[role];
  state.signatures = {};
  saveSession();
  render();
  refresh({ quiet: false });
}

function showSignin(message) {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  if (message) $('#signin-message').textContent = message;
  clearInterval(state.timer);
}

function showApp() {
  $('#signin').hidden = true;
  $('#app').hidden = false;
  if (!signedInRoles().includes(state.role)) state.role = signedInRoles()[0];
  state.tab = HOME_TAB[state.role];
  render();
  refresh({ quiet: false });
  clearInterval(state.timer);
  state.timer = setInterval(() => { refresh(); updateClock(); }, REFRESH_MS);
}

function wireEvents() {
  for (const button of document.querySelectorAll('[data-role]')) button.addEventListener('click', () => switchRole(button.dataset.role));
  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => { state.tab = button.dataset.tab; render(); });
  for (const button of document.querySelectorAll('[data-goto]')) button.addEventListener('click', () => { state.tab = button.dataset.goto; render(); });
  $('#refresh').addEventListener('click', () => refresh({ quiet: false }));
  $('#signout').addEventListener('click', () => {
    state.tokens = {};
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* nothing stored */ }
    showSignin('Signed out. Open a new link from ./aws/setup.sh portal to sign in again.');
  });
  $('#stock-search').addEventListener('input', event => { state.stockQuery = event.target.value; render(); });
  $('#stock-store').addEventListener('change', event => { state.stockStore = event.target.value; render(); });
  $('#token-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('#token-input');
    const tokens = input.value.split(/\s+/).filter(Boolean);
    input.value = '';
    const added = tokens.filter(token => isLive(token) && addToken(token)).length;
    if (!added) return toast('That token is not valid or has expired', 'error');
    state.role = readClaims(tokens[0]).role;
    saveSession();
    showApp();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(updateClock, 1000);
}

async function start() {
  wireEvents();
  loadSession();
  const fromLink = readLinkTokens();
  pruneTokens();
  saveSession();
  if (signedInRoles().length) {
    if (fromLink) toast('Signed in as ' + signedInRoles().map(role => ROLE_LABEL[role]).join(', '), 'ok');
    return showApp();
  }
  // Local Docker runs with API_AUTH_REQUIRED=false: no token needed, every role available.
  const probe = await fetch('/api/stock').catch(() => null);
  if (probe && probe.ok) {
    state.localMode = true;
    return showApp();
  }
  showSignin();
}

start();
