const app = require('../server');

// Normalize the path when Vercel rewrites everything to /api/index.js
// so that the Express app sees the original route (/, /admin, /dashboard, etc).
module.exports = (req, res) => {
  const incomingUrl = new URL(`http://localhost${req.url || '/'}`);
  const pathParam = incomingUrl.searchParams.get('path');
  const headerPath =
    req.headers['x-vercel-original-url'] ||
    req.headers['x-vercel-original-path'] ||
    req.headers['x-original-url'] ||
    req.headers['x-original-path'] ||
    req.headers['x-forwarded-uri'] ||
    req.headers['x-path-info'] ||
    req.headers['x-rewrite-path'] ||
    '';

  const parseRestoredUrl = (value) => {
    if (!value) return null;
    let decoded = String(value);
    try {
      decoded = decodeURIComponent(decoded);
    } catch (_err) {}
    decoded = decoded.replace(/^https?:\/\/[^/]+/i, '');
    if (!decoded.startsWith('/')) decoded = `/${decoded}`;
    const parsed = new URL(decoded, 'http://localhost');
    return {
      pathname: parsed.pathname || '/',
      search: parsed.search || '',
    };
  };

  const headerMatch = parseRestoredUrl(headerPath);
  const pathMatch = parseRestoredUrl(pathParam);
  const fallbackMatch = parseRestoredUrl(req.url || '/');
  const restored = (headerMatch && headerMatch.pathname !== '/api/index.js')
    ? headerMatch
    : (pathMatch || fallbackMatch || { pathname: '/', search: '' });

  const passthroughParams = new URLSearchParams(incomingUrl.search);
  passthroughParams.delete('path');
  const mergedParams = new URLSearchParams(restored.search || '');
  for (const [key, value] of passthroughParams.entries()) {
    if (!mergedParams.has(key)) mergedParams.append(key, value);
  }
  const mergedSearch = mergedParams.toString();
  const finalSearch = mergedSearch ? `?${mergedSearch}` : '';
  let finalPath = restored.pathname || '/';
  if (finalPath === '/api/index.js') finalPath = '/';

  req.url = `${finalPath.replace(/\/{2,}/g, '/')}${finalSearch}`;

  if (process.env.DEBUG_ROUTING === '1') {
    console.log('[vercel-route]', {
      originalUrl: req.originalUrl || '',
      incomingUrl: req.url,
      rawUrl: incomingUrl.toString(),
      pathParam,
      headerPath,
      method: req.method,
    });
  }

  return app(req, res);
};
