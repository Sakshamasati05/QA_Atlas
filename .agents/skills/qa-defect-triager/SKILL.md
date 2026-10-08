---
name: qa-defect-triager
description: Specialized Bug Triage & Defect Reporting skill for converting test failures and anomalies into clear, reproducible Jira defect tickets with severity classification and root-cause hints.
---

# QA Defect Triager Skill

Use this skill when logging defects, analyzing failed test runs, drafting Jira bug tickets, or triaging regressions.

## Core Capabilities
1. **Defect Ticket Drafting**:
   - Structured bug report with:
     - Issue Summary (Component + failure symptom)
     - Severity & Priority classification
     - Environment details (Browser, OS, build version)
     - Preconditions & Test Data
     - Step-by-Step Reproduction Steps
     - Expected vs Actual Results
     - Log / Network payload snippets
     - Suggested Root Cause & Fix Hint
2. **Root Cause Analysis (RCA)**:
   - Identify whether failures stem from frontend race conditions, backend null pointers, API schema mismatches, or network timeouts.
3. **Flaky Test Diagnosis**:
   - Classify flakiness into selector instability, animation race conditions, or unmocked external dependencies.
