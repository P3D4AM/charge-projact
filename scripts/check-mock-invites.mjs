// بررسی هندلرهای دعوت در لایه دمو (mock.js) — بدون مرورگر
const store = {};
globalThis.localStorage = {
  getItem: k => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
globalThis.location = { origin: 'http://localhost' };

const { mockFetch, MOCK_STATE, mockReset } = await import('../public/js/mock.js');

mockReset();
const assert = (cond, name) => { if (!cond) { console.error('✖ ' + name); process.exit(1); } console.log('✔ ' + name); };

// login as demo manager
const lg = await mockFetch('/auth/login', 'POST', { username: 'manager', password: 'manager123' });
assert(lg.__ok && lg.user.role === 'manager', 'demo manager login');

// GET invite → null
let r = await mockFetch('/units/2/invite', 'GET', {});
assert(r.__ok && r.invite === null, 'no active invite initially');

// POST invite → url shape
r = await mockFetch('/units/2/invite', 'POST', { days: 7 });
assert(r.__ok && r.invite.token.length === 24, 'demo invite created (24-hex token)');
assert(r.invite.url === 'https://t.me/DemoBuildingBot?start=' + r.invite.token, 'demo deep-link shape');

// GET invite → now active
r = await mockFetch('/units/2/invite', 'GET', {});
assert(r.__ok && r.invite && r.invite.unit_id === 2, 'active invite visible');

// POST again → renewal with new token
const first = r.invite;
r = await mockFetch('/units/2/invite', 'POST', { days: 30 });
assert(r.__ok && r.invite.token !== first.token && r.invite.days === 30, 'renewal creates fresh token');

// DELETE → revoked
r = await mockFetch('/units/2/invite', 'DELETE', {});
assert(r.__ok, 'revoke ok');
r = await mockFetch('/units/2/invite', 'GET', {});
assert(r.__ok && r.invite === null, 'no active invite after revoke');

// resident forbidden
const rg = await mockFetch('/auth/login', 'POST', { username: 'unit5', password: '1234' });
assert(rg.__ok && rg.user.role === 'resident', 'demo resident login');
r = await mockFetch('/units/2/invite', 'POST', { days: 7 });
assert(!r.__ok && r.status === 403, 'resident blocked from invite endpoints');

console.log('✔ check-mock-invites: all passed');
