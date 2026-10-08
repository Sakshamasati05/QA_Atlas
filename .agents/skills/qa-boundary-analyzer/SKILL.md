---
name: qa-boundary-analyzer
description: Specialized Boundary Value Analysis (BVA), Equivalence Partitioning, and Edge-Case Fuzzing skill for discovering extreme string lengths, numeric boundaries, special characters, unicode, and malformed inputs.
---

# QA Boundary & Edge Analyzer Skill

Use this skill to uncover edge cases, boundary limits, and fuzzed inputs that trigger unhandled exceptions, buffer overruns, or UI distortions.

## Core Capabilities
1. **Boundary Value Analysis (BVA)**:
   - Identify `min - 1`, `min`, `nominal`, `max`, `max + 1` boundaries for string lengths and numbers.
2. **Equivalence Partitioning**:
   - Partition input spaces into valid, invalid, empty, and out-of-range domains.
3. **Multilingual & Unicode Fuzzing**:
   - Test emojis (🚀🔥🎉), Asian glyphs (漢字, 日本語), Right-to-Left (RTL) scripts (العربية, עברית), and zero-width spaces.
4. **Extreme Payloads & Whitespace**:
   - Test whitespace-only strings (`"   "`), leading/trailing whitespace, null characters (`\0`), and floating point rounding anomalies.

## Output Format
- **Title**: `[Edge] Verify <boundary condition description>`
- **Type**: `Edge` or `Negative`
- **Preconditions**: Boundary constraints defined
- **Steps**: Exact extreme values supplied
- **Expected Result**: Clean boundary validation message with no system crashes
- **Priority**: `Medium` or `High`
