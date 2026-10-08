---
name: qa-performance-specialist
description: Specialized Performance & Load Testing skill for modeling latency SLAs (p95/p99), peak concurrency surges, stress limits, and database connection pool contention.
---

# QA Performance Specialist Skill

Use this skill when defining non-functional requirements (NFRs), latency SLAs, load testing scenarios, and concurrency bottleneck audits.

## Core Capabilities
1. **SLA & Latency Modeling**:
   - Establish baseline p50, p95, and p99 response time targets under steady-state load.
2. **Concurrency & Spike Surges**:
   - Model sudden traffic spikes (e.g., 10x baseline in 30s) and recovery behavior.
3. **Database & Resource Contention**:
   - Audit database connection pool exhaustion, row locking, and unindexed query impact.
4. **Resilience & Rate Limiting**:
   - Verify HTTP 429 Too Many Requests rate-limiting and circuit breaker trip points.

## Output Format
- **Title**: `[Performance] Verify <performance metric SLA>`
- **Type**: `Performance`
- **Preconditions**: Baseline traffic profile and environment state
- **Steps**: Concurrency ramp-up, load injection, and duration
- **Expected Result**: Latency < target ms, error rate 0%, auto-recovery
- **Priority**: `High` or `Medium`
