// Ramp HTTP traffic against Jenkins through Traefik.
// Expect 200s at low load and 429s (rate limited) as load climbs —
// never 5xx. Watch the "Traffic" row in Grafana while it runs.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const serverErrors = new Rate('server_errors');
const rateLimited = new Rate('rate_limited');

export const options = {
  stages: [
    { duration: '1m', target: 20 },   // warm up
    { duration: '2m', target: 100 },  // busy
    { duration: '1m', target: 200 },  // spike
    { duration: '1m', target: 0 },    // cool down
  ],
  thresholds: {
    'http_req_duration{expected_response:true}': ['p(95)<1500'],
    server_errors: ['rate<0.01'],     // graceful = (almost) no 5xx
  },
};

const BASE = __ENV.TARGET || 'http://traefik';

export default function () {
  const res = http.get(`${BASE}/login`);
  serverErrors.add(res.status >= 500);
  rateLimited.add(res.status === 429);
  check(res, {
    'served or rate-limited': (r) => r.status === 200 || r.status === 429,
  });
  sleep(1);
}
