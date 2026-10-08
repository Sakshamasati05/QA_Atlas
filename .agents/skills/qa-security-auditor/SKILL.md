---
name: qa-security-auditor
description: Specialized QA Security & Vulnerability Auditor for performing OWASP Top 10 audits, Broken Object Level Authorization (IDOR), JWT token expiry, and SQLi/XSS injection vulnerability analysis on user stories and APIs.
---

# QA Security Auditor Skill

Use this skill when auditing user stories, API endpoints, or web applications for security vulnerabilities, compliance with OWASP Top 10 standards, and data protection rules.

## Core Capabilities
1. **Authentication & Session Security**:
   - Verify JWT bearer token signature verification, expiration handling, and revocation.
   - Test for session fixation, concurrent session limits, and brute-force mitigation.
2. **Authorization & Multi-Tenancy (IDOR)**:
   - Verify Broken Object Level Authorization (BOLA/IDOR) across user and tenant boundaries.
   - Verify role-based access control (RBAC) and principle of least privilege.
3. **Input Sanitization & Injection Defense**:
   - Probe for SQL Injection (`' OR 1=1 --`), NoSQL Injection, XSS (`<script>alert(1)</script>`), and Command Injection.
   - Verify parameter binding, input encoding, and HTML escaping.
4. **Data Protection & Cryptography**:
   - Ensure sensitive fields (passwords, tokens, PII, payment info) are masked in UI and encrypted in transit/rest.

## Output Format
When generating security test cases, format each scenario with:
- **Title**: `[Security] Verify <specific security condition>`
- **Type**: `Security`
- **Preconditions**: Explicit permission state or malformed token context
- **Steps**: Concrete attack vector injection and payload submission steps
- **Expected Result**: HTTP 401/403 rejection, sanitized payload, or zero data leakage
- **Priority**: `High`
