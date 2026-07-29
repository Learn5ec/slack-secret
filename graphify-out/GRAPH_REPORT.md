# Graph Report - .  (2026-07-29)

## Corpus Check
- Corpus is ~15,985 words - fits in a single context window. You may not need a graph.

## Summary
- 208 nodes · 351 edges · 19 communities (10 shown, 9 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 15,500 input · 1,917 output

## Community Hubs (Navigation)
- Secret Storage & Delivery
- Package Manifest
- Bot Runtime & Wiring
- TypeScript Config
- NPM Dependencies
- Encryption & Secret Modal
- Actions & Message Formatting
- Timing/Behavior Config
- Slack Type Definitions
- Slack User ID Cache
- DB Migration Script
- Start-All Script
- Stop-All Script
- Planning Docs
- Envelope Encryption Pattern (doc)
- Secrets Table Schema (doc)
- Views Table Schema (doc)
- Slack Socket Mode (doc)

## God Nodes (most connected - your core abstractions)
1. `main()` - 15 edges
2. `compilerOptions` - 14 edges
3. `logger` - 13 edges
4. `handleModalSubmit()` - 11 edges
5. `loadConfig()` - 9 edges
6. `scripts` - 8 edges
7. `handleSenderSelfView()` - 8 edges
8. `handleRecipientView()` - 8 edges
9. `createDatabases()` - 8 edges
10. `handleViewedByAction()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Implementation Plan: secret-bot` --implements--> `Secret-Bot: Technical Plan`  [EXTRACTED]
  plan.md → idea.md
- `main()` --calls--> `handleViewAction()`  [EXTRACTED]
  src/index.ts → src/bot/actions.ts
- `handleSenderSelfView()` --calls--> `getConfig()`  [EXTRACTED]
  src/bot/actions.ts → src/config/timing.ts
- `handleSenderSelfView()` --calls--> `decryptSecret()`  [EXTRACTED]
  src/bot/actions.ts → src/crypto/secret.ts
- `handleRecipientView()` --calls--> `getConfig()`  [EXTRACTED]
  src/bot/actions.ts → src/config/timing.ts

## Import Cycles
- None detected.

## Communities (19 total, 9 thin omitted)

### Community 0 - "Secret Storage & Delivery"
Cohesion: 0.10
Nodes (20): createClient(), SecretRow, SecretsRepo, createClient(), ViewRow, ViewsRepo, config, DeleteDmMessagePayload (+12 more)

### Community 1 - "Package Manifest"
Cohesion: 0.07
Nodes (27): description, devDependencies, tsx, @types/ioredis, @types/libsodium-wrappers, @types/node, @types/pg, typescript (+19 more)

### Community 2 - "Bot Runtime & Wiring"
Cohesion: 0.15
Nodes (19): CommandArgs, handleSecretCommand(), Config, envSchema, loadConfig(), stopConfigPolling(), closePool(), config (+11 more)

### Community 3 - "TypeScript Config"
Cohesion: 0.09
Nodes (22): bin/**/*.ts, dist, ES2022, node_modules, src/**/*.ts, **/*.test.ts, compilerOptions, declaration (+14 more)

### Community 4 - "NPM Dependencies"
Cohesion: 0.10
Nodes (21): bullmq, dotenv, ioredis, libsodium-wrappers, node-pg-migrate, dependencies, bullmq, dotenv (+13 more)

### Community 5 - "Encryption & Secret Modal"
Cohesion: 0.18
Nodes (14): getUserName(), handleModalSubmit(), ModalSubmitArgs, ALGORITHM, ENVELOPE_VERSION, decryptDataKey(), encryptDataKey(), decryptSecret() (+6 more)

### Community 6 - "Actions & Message Formatting"
Cohesion: 0.22
Nodes (17): ActionArgs, ActionBody, getUserName(), handleCancelAction(), handleHideAction(), handleRecipientView(), handleSenderSelfView(), handleViewAction() (+9 more)

### Community 7 - "Timing/Behavior Config"
Cohesion: 0.24
Nodes (9): BehaviorConfig, CONFIG_PATH, getConfig(), getDefaultConfig(), loadConfigFromFile(), SecretBotConfig, SecurityConfig, startConfigPolling() (+1 more)

### Community 8 - "Slack Type Definitions"
Cohesion: 0.40
Nodes (4): ActionConstraints, ModalSubmitPayload, SecretActionPayload, @slack/bolt

## Knowledge Gaps
- **80 isolated node(s):** `config`, `{ Pool }`, `start-all.sh script`, `stop-all.sh script`, `name` (+75 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `NPM Dependencies` to `Package Manifest`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `logger` connect `Secret Storage & Delivery` to `Bot Runtime & Wiring`, `Encryption & Secret Modal`, `Actions & Message Formatting`, `Timing/Behavior Config`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `config`, `{ Pool }`, `start-all.sh script` to the rest of the system?**
  _80 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Secret Storage & Delivery` be split into smaller, more focused modules?**
  _Cohesion score 0.09682539682539683 - nodes in this community are weakly interconnected._
- **Should `Package Manifest` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `Bot Runtime & Wiring` be split into smaller, more focused modules?**
  _Cohesion score 0.14855072463768115 - nodes in this community are weakly interconnected._
- **Should `TypeScript Config` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._