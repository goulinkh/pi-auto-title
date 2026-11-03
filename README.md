# pi-auto-title

Gives an unnamed Pi session a name, without ever getting in the way.

The extension waits until the agent's first turn has settled — the reply is
already on screen — and only then asks a model for a short title from the
opening exchange. The first message is never delayed, blocked, or rewritten.
Titles are short (the model is asked for at most 4 words by default), so
they still fit where a terminal shows its title, such as a tab.

## Install

```sh
pi install npm:pi-auto-title
```

## Why not in the message path

Some auto-title extensions generate the name inside `input` or
`before_agent_start`, which means every first message of every session waits
for an extra model round-trip before the agent even sees it. This extension
hooks `agent_settled` instead: by the time it does anything, the turn it
names is already over. Generation failures are silent — a session that cannot
be titled keeps whatever name it has, including none.

## Behavior

- A session with a name is never renamed automatically: `--name`, `/name`,
  and names from a resumed session are all respected.
- Each session is titled at most once, after its first settled turn.
- If you rename the session yourself afterwards, the extension stands down
  for the rest of that session and never touches the name again.
- `/retitle` regenerates the title on demand, even after you renamed the
  session by hand; the new automatic name becomes the one the extension
  tracks.
- A titling model named by the environment or the config file that
  cannot be resolved or has no configured auth disables titling rather
  than falling back to the session's model. Quota is never spent
  somewhere you did not ask.

## Configuration

These commands set the persistent preferences from inside Pi:

- `/title-model` — pick the model titles are generated with in a
  searchable picker styled after Pi's own `/model` page (type to
  filter; the entry currently in effect is marked), or run it as
  `/title-model provider/model-id`; `clear` returns to the session
  model.
- `/title-language` — pick the language titles are written in, or run
  it as `/title-language zh`; `auto` (or `clear`) matches the
  conversation again. Any language name may be written in the config
  file directly.
- `/title-words` — show how many words titles are asked to stay
  within, or set it with `/title-words 3`; `clear` returns to the
  default of 4. It is what the model is asked for, not a hard cut:
  `PI_AUTO_TITLE_MAX_LENGTH` is the hard cap.
- `/title-status` — show the preferences in effect and the most
  recent generation record in this session.

## Generation records

Every generation attempt leaves a `pi-auto-title` entry in the
session file: when it ran, which model was requested and which
layer chose it, the model the provider reports actually answering
(with its response id when it sends one), and how the attempt
ended — titled, failed, or skipped fail-closed with the reason.
Nothing is written anywhere else, and the entries are not part of
the conversation the model sees. Grep a session file for
`pi-auto-title` to audit what named your sessions.

Choices are stored in the extension's own file,
`~/.pi/agent/pi-auto-title.json` (or `$PI_CODING_AGENT_DIR`), never in
Pi's `settings.json`:

```json
{ "model": "openrouter/deepseek/deepseek-chat", "language": "en", "words": 3 }
```

Every key is optional, and the file may be edited by hand — it is
re-read whenever a title is generated. If the file is a symlink (kept
in a dotfiles repository, say), the commands write through it and
leave the link in place. Resolution is key by key:
an environment variable beats the config file, which beats the
default (the session model; the conversation's language; 4 words).

| Variable                 | Default | Description                                                        |
| ------------------------ | ------- | ------------------------------------------------------------------ |
| `PI_AUTO_TITLE`          | on      | Set to `0`, `false`, `off`, or `no` to disable titling entirely.   |
| `PI_AUTO_TITLE_MODEL`    | unset   | `provider/model-id` to title with; overrides the config file.      |
| `PI_AUTO_TITLE_LANGUAGE` | unset   | Language to title in (`en`, `zh`, `Japanese`, …); overrides the config file. |
| `PI_AUTO_TITLE_WORDS`    | `4`     | Most words the model is asked to use; overrides the config file.   |
| `PI_AUTO_TITLE_MAX_LENGTH` | `60`  | Hard cap on title length in characters, cut mid-word if reached.   |

## Development

```sh
npm install
npm test    # node --test over test/
npm run check  # tsc --noEmit
```

`src/policy.ts` is pure logic and fully unit-tested. `src/generate.ts`
does the single model call with a 15-second timeout. `src/extension.ts`
is wiring only: events, the per-session state machine, and `/retitle`.
