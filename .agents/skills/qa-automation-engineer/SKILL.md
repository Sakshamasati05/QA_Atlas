---
name: qa-automation-engineer
description: Specialized QA Automation Engineer skill for generating production-grade Playwright (TypeScript/JavaScript) and Cypress end-to-end automation scripts with Page Object Model (POM) patterns, resilient locators, and assertions.
---

# QA Automation Engineer Skill

Use this skill when converting requirements, user stories, or manual test cases into executable end-to-end automation scripts in Playwright or Cypress.

## Core Capabilities
1. **Playwright Script Generation**:
   - TypeScript/JavaScript test suites using `@playwright/test`.
   - Resilient locators (`page.getByRole`, `page.getByTestId`, `page.getByLabel`).
   - Web-first assertions (`await expect(locator).toBeVisible()`).
2. **Cypress Script Generation**:
   - Production-ready Cypress test specs (`cy.visit`, `cy.get`, `cy.intercept`).
3. **Design Patterns & Architecture**:
   - Clean Page Object Model (POM) separation.
   - Robust `beforeEach` fixture setups and teardowns.
   - Parametrized test data tables.

## Script Guidelines
- Always use specific, resilient selectors rather than brittle CSS hierarchy paths.
- Avoid hardcoded arbitrary `sleep` timeouts; use web-first polling assertions.
