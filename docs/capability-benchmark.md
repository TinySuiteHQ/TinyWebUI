# Capability benchmark (offline)

Scripted provider; character/4 estimates on actual requests. These are not measured provider tokens, model behavior, cache hits, or billed cost. Run `npm run eval:capabilities -- --live` with a configured endpoint for provider measurements.

| Task | Mode | Requests | Estimated total input | Estimated matching prefix | Script passed |
|---|---|---:|---:|---:|---|
| plain | eager | 1 | 3,442 | 0 | True |
| plain | lazy | 1 | 336 | 0 | True |
| memory | eager | 2 | 6,936 | 3,469 | True |
| memory | lazy | 3 | 4,440 | 2,176 | True |
| web | eager | 2 | 6,934 | 3,470 | True |
| web | lazy | 3 | 4,439 | 2,179 | True |
| both | eager | 3 | 10,499 | 7,028 | True |
| both | lazy | 4 | 11,498 | 7,611 | True |
| research | eager | 4 | 14,189 | 10,707 | True |
| research | lazy | 5 | 8,882 | 6,630 | True |

The combined-capability case is more expensive in lazy mode because both groups are needed and discovery adds a round. This is why lazy loading remains opt-in. Prefix estimates describe repeated serialized bytes, not tokenizer-aligned cache units.

Validation: 228 passing tests, 2 existing skips; Statistics DOM checks cover model filters, year/month/day selection, totals, bars and empty-state clearing. Live provider cache/cost validation remains outstanding.
