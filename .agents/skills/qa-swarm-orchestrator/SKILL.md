---
name: qa-swarm-orchestrator
description: Master Multi-Agent QA Swarm Orchestrator for coordinating parallel specialized QA agents (Security, Boundary, Performance, Automation, Architecture, Bug Triage) to generate comprehensive 360-degree Quality Assurance reports and unified test suites.
---

# Multi-Agent QA Swarm Orchestrator Skill

Use this skill when executing a complete 360-degree quality audit on a complex feature or User Story.

## Swarm Workflow
1. **Context Ingestion**:
   - Ingest User Story, Acceptance Criteria, and technical metadata.
2. **Parallel Agent Execution**:
   - 🛡️ **Security Agent**: OWASP vulnerability audit & IDOR test generation.
   - 🔍 **Boundary Agent**: BVA & extreme value fuzzing.
   - ⚡ **Performance Agent**: Latency SLAs & stress concurrency limits.
   - 🤖 **Automation Agent**: Playwright & Cypress test scripts.
   - 🎯 **Architecture Agent**: Risk matrix & requirement traceability.
   - 🐞 **Defect Agent**: Proactive defect scenarios & edge tickets.
3. **Consolidation & Deduplication**:
   - Merge test cases from all agents.
   - Deduplicate overlapping scenarios.
   - Compute overall Quality Health Score (0-100%).
4. **1-Click Repository Persistence**:
   - Export full test suite into the SQLite database.
