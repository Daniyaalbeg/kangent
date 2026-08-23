---
tracker:
  kind: kangent
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done"]
  kangent:
    endpoint: https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev
    board_id: replace-with-real-board-id
    label_filter: ["agent-ready"]
    label_exclude: ["wip", "human-only"]

polling:
  interval_ms: 30000

agent:
  max_concurrent_agents: 3
  max_turns: 20

codex:
  command: codex app-server
  turn_timeout_ms: 3600000
---

You are working on a Kangent card.

**{{ issue.identifier }} — {{ issue.title }}**

{{ issue.description }}

When you finish, use the kangent_card tool to move this card to "Human Review".
