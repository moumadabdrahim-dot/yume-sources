const crypto = require('node:crypto');

const API = 'https://ostvapp.cam';
const CERT_SHA256 = '6e2fcda8631eb49ebcba4ca8ef4c597abe84654c7d3e8096db32bdd21ecf763f';
const PACKAGE_NAME = 'com.drama.mp4';
const IRON_DIAG = 'f=6e2fcda8 p=6e2fcda8 h=0';
const UA = 'okhttp/4.12.0';
const categories = [
  { id: 'movies', type: 'movie', path: '/api/movies/' },
  { id: 'series', type: 'series', path: '/api/series/' },
  { id: 'anime', type: 'anime', path: '/api/anime/' }
];

function deriveKey() {
  let bytes = Buffer.from(`${CERT_SHA256}|${PACKAGE_NAME}`, 'utf8');
  const xor = mask => { for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % mask.length]; };
  xor(Buffer.from('OscarTV'));
  bytes = Buffer.from(bytes).reverse();
  xor(Buffer.from('IronGuard'));
  for (let i = 0; i < 3; i++) bytes = crypto.createHash('sha256').update(bytes).digest();
  return bytes;
}
const key = deriveKey();

async function get(category, { page = 1, limit = 20, search } = {}) {
  const url = new URL(category.path, API);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(limit));
  if (search != null) url.searchParams.set('search', search);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(4).toString('hex');
  const signature = crypto.createHmac('sha256', key).update(`${category.path}|${timestamp}|${nonce}`).digest('hex');
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA, 'X-Iron-Sig': signature,
      'X-Iron-Ts': timestamp, 'X-Iron-Nonce': nonce, 'X-Iron-Diag': IRON_DIAG },
    signal: AbortSignal.timeout(20000)
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
}

function summarize(label, response) {
  const data = response.payload && response.payload.data;
  const items = Array.isArray(data) ? data : [];
  const pagination = response.payload && response.payload.pagination || {};
  console.log(JSON.stringify({
    label,
    http: response.status,
    apiStatus: response.payload && response.payload.status || null,
    itemCount: items.length,
    page: pagination.page || null,
    pageCount: pagination.page_count || pagination.total_pages || pagination.last_page || null,
    total: pagination.total || null
  }));
  return items;
}

(async () => {
  const firstPages = new Map();
  for (const category of categories) {
    const response = await get(category);
    firstPages.set(category.id, summarize(`${category.id}:page1`, response));
  }
  summarize('movies:page2', await get(categories[0], { page: 2 }));
  for (const category of categories) {
    const item = firstPages.get(category.id).find(entry => entry && (entry.title_ar || entry.title_en || entry.title_jp));
    const query = item && (item.title_ar || item.title_en || item.title_jp);
    if (!query) {
      console.log(JSON.stringify({ label: `${category.id}:search`, skipped: 'no title in page 1' }));
      continue;
    }
    summarize(`${category.id}:search`, await get(category, { search: query }));
  }
})().catch(error => {
  console.error(JSON.stringify({ error: error && error.message || String(error) }));
  process.exitCode = 1;
});
