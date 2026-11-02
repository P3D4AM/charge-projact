// Tiny route registry with path params.
export const routes = [];

export function route(method, path, handler, access = 'user') {
  routes.push({ method, path, handler, access });
}

export function matchRoute(method, path) {
  const pa = path.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const pp = r.path.split('/').filter(Boolean);
    if (pp.length !== pa.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(pa[i]);
      else if (pp[i] !== pa[i]) { ok = false; break; }
    }
    if (ok) return { r, params };
  }
  return null;
}
