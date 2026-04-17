require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const UserAgent = require('user-agents');

const app = express();
const REAL_PANEL = process.env.REAL_PTERODACTYL_URL;
const PORT = process.env.GATEWAY_PORT || 3000;

// ---------- 1. Baca & siapkan proxy rotator ----------
let proxies = fs.readFileSync('proxies.txt', 'utf8')
  .split('\n')
  .filter(line => line.trim())
  .map(line => {
    const [host, port, user, pass] = line.split(':');
    return { host, port, user, pass, url: `http://${user}:${pass}@${host}:${port}` };
  });

let currentProxyIndex = 0;
function getNextProxyAgent() {
  const proxy = proxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  return new HttpsProxyAgent(proxy.url);
}

// ---------- 2. Anti-intip: hapus semua header yang mencurigakan ----------
function stripHeaders(headers) {
  const safeHeaders = { ...headers };
  const blockedHeaders = ['x-powered-by', 'server', 'via', 'x-aspnet-version', 'x-request-id', 'cf-ray', 'x-forwarded-for', 'forwarded', 'x-real-ip'];
  blockedHeaders.forEach(h => delete safeHeaders[h]);
  // Ganti user-agent dengan random
  safeHeaders['user-agent'] = new UserAgent().toString();
  return safeHeaders;
}

// ---------- 3. Rate limiting & auto-suspend (DDoS protection) ----------
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 60, // max 60 request per menit per IP
  handler: (req, res) => {
    console.log(`[SUSPEND] IP ${req.ip} kena rate limit, di-suspend sementara`);
    res.status(429).send('🚫 Aktivitas mencurigakan terdeteksi. Coba lagi nanti.');
  },
  keyGenerator: (req) => req.ip,
  skip: (req) => false,
});

app.use(limiter);

// ---------- 4. Middleware anti-intip: ubah semua response header ----------
app.use((req, res, next) => {
  // Hapus header default Express
  res.removeHeader('X-Powered-By');
  // Ganti header server dengan palsu
  const oldWriteHead = res.writeHead;
  res.writeHead = function(statusCode, statusMessage, headers) {
    res.setHeader('Server', 'CloudFront/2.0'); // Palsuin kayak AWS
    oldWriteHead.apply(res, arguments);
  };
  next();
});

// ---------- 5. Proxy dengan rotasi proxy per request ----------
app.use('*', async (req, res, next) => {
  try {
    const proxyAgent = getNextProxyAgent();
    // Gunakan http-proxy-middleware tapi dengan agent dinamis agak repot.
    // Alternatif: pakai axios sebagai proxy handler manual.
    // Tapi biar sederhana, kita override target dengan agent via custom proxy middleware.
    // Karena http-proxy-middleware support agent? Tidak langsung. Jadi kita buat handler sendiri pakai axios.
    // Saya pilih cara manual: forward request ke panel asli lewat proxy.
    const axios = require('axios');
    const targetUrl = `${REAL_PANEL}${req.url}`;
    const method = req.method;
    const headers = stripHeaders(req.headers);
    // Hapus header host asli
    delete headers.host;
    
    const response = await axios({
      method,
      url: targetUrl,
      headers,
      data: method !== 'GET' ? req.body : undefined,
      httpsAgent: proxyAgent,
      httpAgent: proxyAgent,
      responseType: 'stream',
      validateStatus: () => true,
    });
    
    // Copy response status & headers (kecuali header berbahaya)
    res.status(response.status);
    const safeResHeaders = stripHeaders(response.headers);
    Object.keys(safeResHeaders).forEach(key => {
      res.setHeader(key, safeResHeaders[key]);
    });
    // Tambahan: hilangkan header yang mungkin bocorkan panel asli
    res.removeHeader('location'); // redirect bisa bocorkan URL asli? Kita modifikasi location jika perlu
    if (response.headers.location) {
      // Ubah location jadi relatif atau pakai domain gateway
      let newLocation = response.headers.location.replace(REAL_PANEL, '');
      res.setHeader('location', newLocation);
    }
    
    response.data.pipe(res);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).send('Gateway error: panel tidak bisa dijangkau');
  }
});

// ---------- 6. Jalankan server ----------
app.listen(PORT, () => {
  console.log(`🛡️ Pterodactyl Shield aktif di port ${PORT}`);
  console.log(`🔒 Panel asli ${REAL_PANEL} terlindungi oleh ${proxies.length} proxy rotasi`);
  console.log(`✅ Anti-intip server & node: aktif`);
  console.log(`⚠️ Auto-suspend DDoS: aktif (60 req/menit per IP)`);
});
