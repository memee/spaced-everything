---
se-interval: 7
se-ease: 2.5
se-last-reviewed: 2023-01-01T00:00:00Z
se-method: SuperMemo 2.0 (Simplified)
---

# Matured

A note whose schedule has already grown past the defaults: interval 7 rather than 1.

The other onboarded fixtures all sit at interval 1, where `prevInterval × newEase`
happens to equal `newEase`, so they cannot tell apart multiplying by the *previous*
ease from multiplying by the *newly adjusted* one. This note can: reviewing it as
Unfruitful (score 5) must produce 7 × 2.6 = 18.2, not 7 × 2.5 = 17.5.

Its due date is 2023-01-08, later than every other overdue fixture, so it lands at
the back of the review queue and leaves the `open-next-review-item` ordering
unchanged.
