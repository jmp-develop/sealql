# SealQL integration

SealQL exposes an ORM-neutral cryptographic core and versioned database adapters. Choose the layer that owns the operation instead of treating the current Drizzle adapter as the whole package.

## Choose a surface

| Need | Read | Import | Example |
|---|---|---|---|
| Field sealing/opening without database integration | [Core concepts](core-concepts.md) | `sealql` | [Core sealer](../examples/core/sealer.ts) |
| PostgreSQL fields, managed writes, and verified search through Drizzle ORM 0.45 | [Drizzle ORM 0.45](adapters/drizzle-v0.45.md) | `sealql` and `sealql/drizzle/v0.45` | [Injected integration flow](../examples/drizzle/v0.45/app.ts) and [runner](../scripts/run-drizzle-v0.45-example.ts) |

Read [core concepts](core-concepts.md) before an adapter guide. The core document owns key policy, search-field selection, leakage, scope authorization, count/budget policy, and rebuild invariants. The adapter document owns installation, schema APIs, query shapes, migrations, drivers, and error handling.

## Supported adapters

- [Drizzle ORM 0.45](adapters/drizzle-v0.45.md), requiring `drizzle-orm >=0.45.2 <0.46`.

There is no Prisma or Drizzle v1 adapter yet. Do not create imports, examples, or compatibility claims for an adapter that is not exported by `package.json`.

## Implementation and security references

- [Current state](current-state.md) records what is implemented and verified now.
- [Threat model](threat-model.md) is the canonical leakage and attacker statement.
- [Verification](verification.md) and [measurement](measurement.md) define evidence requirements.
- [Experiments](experiments.md) separates adopted behavior from rejected research.
