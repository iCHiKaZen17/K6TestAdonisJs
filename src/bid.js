import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';


// ===== ENV =====
const BASE_URL        = __ENV.BASE_URL || 'http://localhost:3333';
const USER_LOGIN_PATH = __ENV.USER_LOGIN_PATH || '/auth/login';
const BID_PATH        = __ENV.BID_PATH || '/pembeli/pengajuan-lelang';

const LELANG_ID   = Number(__ENV.LELANG_ID);
const USER_PREFIX = __ENV.USER_PREFIX || 'k6buyer';
const USER_DOMAIN = __ENV.USER_DOMAIN || 'example.com';
const USER_PASS   = __ENV.USER_PASSWORD || 'Password123!';
const USER_COUNT  = Number(__ENV.USER_COUNT || 100);
const USER_EMAIL_SUFFIX = __ENV.USER_EMAIL_SUFFIX ? `-${__ENV.USER_EMAIL_SUFFIX}` : '';
const USER_INDEX_MIN = Number(__ENV.USER_INDEX_MIN || 1);
const USER_INDEX_MAX = Number(__ENV.USER_INDEX_MAX || USER_COUNT);
const USER_PACE_MS   = Number(__ENV.USER_PACE_MS || 0);

const LOGIN_TIMEOUT = __ENV.LOGIN_TIMEOUT || '300s';
const REQ_TIMEOUT   = __ENV.REQ_TIMEOUT   || '300s';

const MIN_BID  = Number(__ENV.MIN_BID  || 250);
const MAX_BID  = Number(__ENV.MAX_BID  || 10000000);
const BID_STEP = Number(__ENV.BID_STEP || 250);

// ===== Metrics =====
export const bids_success = new Counter('bids_success');
export const bids_failed  = new Counter('bids_failed');
export const bid_ok       = new Rate('bid_ok');

// ===== Options =====
export const options = {
  scenarios: {
    two_bids_per_user: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,      // 100 user
      iterations: 2,        // masing2 user 2 bid (2 iterasi)
      maxDuration: '60m',
    },
  },
  thresholds: {
    // http_req_failed: ['rate<0.05'],
    // bid_ok: ['rate>0.95'],
  },
};

// ===== Utils =====
function extractToken(res) {
  return (
    res.json('data.access_token') ||
    res.json('data.accessToken')  ||
    res.json('data.token')        ||
    res.json('access_token')      ||
    res.json('token')             ||
    res.json('authorization.token') ||
    null
  );
}

function apiLogin(path, email, password) {
  const res = http.post(`${BASE_URL}${path}`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: LOGIN_TIMEOUT,
  });
  const token = extractToken(res);
  check(res, { 'login ok & token': (r) => r.status === 200 && !!token });
  if (!token) {
    console.warn(`Login gagal status=${res.status} body=${String(res.body).slice(0,200)}`);
  }
  return token;
}

function randStep(min, max, step) {
  const start = Math.ceil(min / step) * step;
  const end   = Math.floor(max / step) * step;
  if (end < start) return start;
  const steps = Math.floor((end - start) / step);
  const k = Math.floor(Math.random() * (steps + 1));
  return start + k * step;
}

function emailForIndex(idx) {
  return `${USER_PREFIX}${String(idx).padStart(3, '0')}${USER_EMAIL_SUFFIX}@${USER_DOMAIN}`;
}

function postBid(token, payload) {
  return http.post(`${BASE_URL}${BID_PATH}`, JSON.stringify(payload), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: REQ_TIMEOUT,
  });
}

// ===== per-VU state (di-copy per VU) =====
let lastBidAtMs = 0;
let vuToken = null;
let vuEmail = null;

export default function () {
  if (!LELANG_ID) throw new Error('Set -e LELANG_ID');

  // Tetapkan email untuk VU ini sekali
  if (!vuEmail) {
    const span = (USER_INDEX_MAX - USER_INDEX_MIN + 1);
    const idx  = USER_INDEX_MIN + ((Number(__VU) - 1) % span);
    vuEmail = emailForIndex(idx);
  }

  // Login sekali per VU (cache token)
  if (!vuToken) {
    vuToken = apiLogin(USER_LOGIN_PATH, vuEmail, USER_PASS);
    if (!vuToken) return;
    sleep(Math.random() * 0.05); // jitter kecil setelah login
  }

  // pacing antar-bid
  const now = Date.now();
  const remaining = Math.max(0, USER_PACE_MS - (now - (lastBidAtMs || 0)));
  if (remaining > 0) sleep(remaining / 1000);

  // payload bid
  const payload = {
    lelang_id: LELANG_ID,
    harga_penawaran: randStep(MIN_BID, MAX_BID, BID_STEP),
  };

  const res = postBid(vuToken, payload);

  const ok = !!res && res.status >= 200 && res.status < 300;
  bid_ok.add(ok);
  ok ? bids_success.add(1) : bids_failed.add(1);

  check(res, { 'bid ok': (r) => r && [200, 201, 202].includes(r.status) });
  if (!ok) {
    console.warn(`Bid gagal email=${vuEmail} status=${res && res.status} body=${String(res && res.body).slice(0,200)}`);
  }

  lastBidAtMs = Date.now();
  sleep(0.1);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'reports/summary.html': htmlReport(data),
    'reports/summary.json': JSON.stringify(data, null, 2),
  };
}