# pricing-engine

Cart pricing for the storefront checkout. It prices line items, applies coupon
and line level discounts, and splits sales tax per jurisdiction.

Every amount is an integer in minor units, so nothing downstream has to deal
with binary floating point money. Convert at the edges with `toMinor` and
`formatMinor` from `src/money.ts`.
