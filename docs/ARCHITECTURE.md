# Architecture

Guild is a web app (`web/`) plus a Node server (`server/`) that runs every Bot's agent loop. Each Bot runs on a model provider of your choice - MiniMax, Anthropic, DeepSeek, OpenRouter, MiMo, Grok or anything OpenAI-compatible - and works on the computers you point it at: the machine running the server, other machines you have registered, and cloud-synced folders.

## Components

| Piece | Where | What it does |
|---|---|---|
| API + realtime | `server/src/routes*.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream per user (`GET /api/events`) carrying row updates, live state, roster changes and computer state |
| Agent loop | `server/src/agent/loop.ts` | Per-Bot serial queue. Each turn builds the system prompt and history, streams the Bot's model with function tools, runs tool calls, and repeats until the model answers |
| Providers | `server/src/llm/` | One interface (`ProviderCall` in, `ProviderEvent` out) with an implementation per API family: `anthropic.ts` (Anthropic, MiniMax), `openai.ts` (OpenAI-compatible), `xai.ts` (Grok's Responses API, with hosted search), `mock.ts` (offline). `profiles.ts` builds the profiles from the environment; `translate.ts` maps the canonical transcript to each provider's shape |
| Tools | `server/src/agent/tools.ts` | Memory (`remember`/`recall`), routines, tasks, `send_to_bot`, subagents, group chats, `ask_user`, `request_app_connection`, plus Composio's meta tools for 1,000+ apps |
| Local machine | `server/src/agent/local.ts` | `local_read_file`, `local_write_file`, `local_list_dir`, `local_search`, `local_shell` on the machine running the server. Paths are resolved inside the allowed roots (`LOCAL_ROOTS` and the Bot's own workspace); writes and shell commands ask the user first |
| Team | `server/src/agent/team.ts` | `manage_team` (list, spawn, assign, inspect, set role, retire) and `team_digest`. The Guildmaster (the primary Bot) uses them to run the team |
| Machines | `server/src/machines.ts`, `server/src/agent/machine-tools.ts`, `machine-agent/agent.mjs` | A registry of your other computers. An agent on each machine registers with `MACHINE_TOKEN`, polls for jobs and runs them. Bots reach them with `machine_list`, `machine_run`, `machine_read_file`, `machine_write_file` |
| Cloud | `server/src/agent/cloud.ts` | `cloud_sync` pushes a workspace into, or pulls it out of, a synced folder (`CLOUD_ROOT`), which is how work moves between computers |
| Memory | `server/src/agent/memory.ts`, `agent/prompt.ts` | Compacts long histories (xAI's `/responses/compact` where available, otherwise a summary through the Bot's own provider). Consolidates durable facts after a chat goes idle. Keeps a bounded memory section in the prompt |
| Cloud desktops | `server/src/computer.ts`, `orgo.ts`, `idle.ts` | Optional: one Orgo Linux VM per user, with one Orgo *screen* per Bot, leased least-recently-used among idle Bots. Auto-suspends after 20 idle minutes |
| Viewer | `server/src/vnc.ts` | WebSocket relay between the browser (noVNC) and Orgo's websockify. The server completes VNC auth upstream, so the VM password never reaches the browser |
| Apps | `server/src/composio.ts`, `triggers.ts` | Optional: catalog, per-user sessions, connect links, tool execution, and triggers for event routines |
| Scheduling | `server/src/routines.ts`, `proactive.ts` | Cron routines (croner), event routines, and proactive check-ins for the primary Bot |
| Voice | `server/src/voice.ts`, `web/src/voice/*` | Optional: short-lived xAI realtime client secrets, with the browser talking to `wss://api.x.ai/v1/realtime` directly |
| UI | `web/src` | React + zustand. Sidebar, chat, details panel (activity, tasks, library), modals, settings, viewer, voice call bar, and the per-Bot provider/model picker |

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`.

- **Streaming:** a streaming reply is the same row rewritten with a higher `updatedSeq`, so clients just upsert by `seq`.
- **Resetting:** a per-Bot `generation` counter resets the conversation ("new conversation").
- **Model history:** the Responses API input items live separately in `llm_items` (`store:false`), and encrypted reasoning is passed back unchanged.
  - Only the last 3 screenshots stay inline.
  - Orphaned tool calls from an interrupted turn are repaired before the next call.

Row kinds:
- `message`: user or assistant, optionally *from* another Bot or a voice call
- `tool-call`: shown in the UI only as an activity line and a collapsible step list
- `card`: approval, question, connect, draft
- `event`: routine created or run, voice call, group changes
- `notice`

## Approvals

The loop checks policy before executing each tool call:
- A Bot's own computer and shell run freely.
- Composio tools whose slug reads as read-only (`*_GET`, `*_LIST`, `*_SEARCH`, …) run automatically.
- Anything else posts an **approval card** and pauses the turn, saving the pending calls in `pending_turns`. The turn resumes when the user answers.
  - **Allow** runs the call once.
  - **Always allow** stores a per-tool policy.
  - **Don't allow** sends the model a refusal telling it not to retry.
- A new user message closes any pending approval as expired.

## Bots working together

- **`send_to_bot`:** delivers a message to another Bot's queue. The reply comes back the same way.
- **Subagents:** hidden child Bots with their own context and screen. They report back with `send_to_bot` and are removed with `stop_subagent`.
- **Group chats:** a Bot row with `kind='room'` and a member list. A user message goes to the @mentioned members, or to all members (up to 3). Each member answers in the group with `post_to_group`.

## Data

SQLite (`data/guild.db`, WAL) holds:
- users and sessions
- Bots, rows, model history
- approvals, policies
- routines, tasks, memories, skills
- computers and screen leases
- Composio session ids, compactions, check-in settings
- registered machines and their job queue

Secrets live only in `.env` on the server.

## External services

Everything below is optional except a model provider.

| Service | Used for | Notes |
|---|---|---|
| Model providers | Every turn | MiniMax, Anthropic, DeepSeek, OpenRouter, MiMo, Grok, or any OpenAI-compatible server. Chosen per Bot |
| Google Drive / OneDrive | Moving work between computers | Point `CLOUD_ROOT` at the synced folder; the `cloud_sync` tool pushes and pulls workspaces |
| xAI | Voice, TTS, STT, and the hosted search tools when a Bot runs on Grok | Voice needs `XAI_API_KEY` |
| Orgo | VMs, screens, actions (screenshot, click, type, key, scroll, drag, bash), VNC, files | Only if you want cloud desktops instead of your own machines |
| Composio | Connected apps, triggers, sign-in | Only if you want 1,000+ app integrations |
