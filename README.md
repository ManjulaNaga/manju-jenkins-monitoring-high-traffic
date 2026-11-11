# Jenkins for real traffic — with Prometheus + Grafana

## Architecture
```
 users / webhooks
        │  :80
 ┌──────▼──────────────────────────────────────────────┐
 │ Traefik (edge)                                      │
 │  1 errors      502/503/504 → friendly maintenance page
 │  2 ratelimit   >50 req/s per client → 429           │
 │  3 inflightreq >100 concurrent → 429                │
 │  4 circuit breaker  failing backend → back off      │
 │  5 retry       transient network errors             │
 │  health check  /login every 10s → stop routing      │
 └──────┬──────────────────────────────────────────────┘
        │
 ┌──────▼───────────┐  docker.sock   ┌──────────────────┐
 │ Jenkins controller│──────────────►│ agent containers │  0 … AGENT_MAX
 │ 0 executors       │  start/stop   │ (one per build)  │  created on demand,
 │ schedules only    │◄──────────────│ jenkins/agent    │  removed after 1 idle min
 └──────────────────┘                └──────────────────┘
 Prometheus ◄── traefik, jenkins /prometheus/, cadvisor, blackbox probes
 Grafana    ◄── Prometheus
```

## Run
```bash
cp .env.example .env            # set passwords; tune limits if you like
docker pull jenkins/agent:jdk21 # pre-pull so the first agent starts fast
docker compose up -d --build
docker compose ps
```

| Service           | URL |
|-------------------|-----|
| Jenkins           | http://localhost  (port 80, through Traefik) |
| Grafana           | http://localhost:3000 |
| Prometheus        | http://localhost:9090 |
| Traefik dashboard | http://localhost:8088 |

Monitoring ports are bound to 127.0.0.1 — reachable only from your Mac.

## How traffic is handled gracefully

| Situation | What happens | What the user sees |
|---|---|---|
| Normal load | Requests pass straight through | Jenkins |
| One client floods requests | Rate limit (`RATE_LIMIT_AVG`/`BURST`) | HTTP 429, others unaffected |
| Too many concurrent requests | In-flight cap (`MAX_INFLIGHT`) | HTTP 429 instead of Jenkins slowing for everyone |
| Jenkins starting / restarting | Health check fails → no routing | Maintenance page (auto-refresh), status 503 |
| Jenkins erroring heavily | Circuit breaker opens for 10s, then ramps back over 20s | Maintenance page instead of timeouts |
| Brief network hiccup | Retried up to 2 times | Nothing |
| Many builds at once | Agent containers start per build, up to `AGENT_MAX` | Builds start quickly; extras wait in queue |
| `docker compose down` | Traefik drains for 30s, Jenkins gets 120s to save state | In-flight requests finish |

## Try it

### Build traffic spike
1. Jenkins → **load-generator** → *Build with Parameters* → `COUNT=30`.
2. Watch Grafana → **Build capacity**: agents rise to `AGENT_MAX`, queue drains, agents disappear ~1 min after.

### HTTP traffic spike
```bash
docker compose --profile loadtest run --rm k6
```
Ramps to 200 virtual users over 5 minutes. Watch Grafana → **Traffic**:
200s at first, then 429s as limits kick in — and the 5xx line stays at zero.
k6 fails its threshold if more than 1% of responses are 5xx.

### Restart while serving
```bash
docker compose restart jenkins
```
Open http://localhost — maintenance page until Jenkins is ready, then it returns automatically.

## Tuning (in `.env`, then `docker compose up -d`)
* `AGENT_MAX` — more parallel builds (each agent ≈ 0.5–1 GB RAM)
* `RATE_LIMIT_AVG` / `RATE_LIMIT_BURST` — per-client request rate
* `MAX_INFLIGHT` — concurrent requests Jenkins receives
* Jenkins memory — `deploy.resources.limits.memory` in `docker-compose.yml` (heap = 75%)

## Alerts (Prometheus → Alerts)
Probes: liveness, readiness, slow startup · Resources: CPU, memory, heap ·
Traffic: backend unhealthy, 5xx > 5%, p95 > 2s, rate limiting active ·
Capacity: queue backlog, agent cap reached.

## Limits of this setup
* One Jenkins controller — it cannot be load-balanced across replicas. Scaling
  is done by moving builds to agents and protecting the controller.
* Single Docker host. For multi-host autoscaling, move agents to Kubernetes
  (Jenkins `kubernetes` plugin) — the same monitoring still applies.
* No TLS. For internet exposure, add a Let's Encrypt resolver to Traefik.

## Troubleshooting
* **Agents never start** — `docker compose logs jenkins | grep -i docker`;
  usually docker.sock permissions (set `DOCKER_GID` on Linux).
* **Builds stuck "waiting for next available executor"** — check
  Manage Jenkins → Clouds → docker → Test Connection.
* **Traffic panels empty** — Prometheus → Targets → `traefik` must be UP.
