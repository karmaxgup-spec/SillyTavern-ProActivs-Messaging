# Proactive Messaging (SillyTavern extension)

Makes the character send a natural follow-up message on its own when:

1. The conversation has actually been "flowing" recently (not one message and silence for an hour), **and**
2. You've stopped responding for a while, **and**
3. Your SillyTavern tab is still open/focused ("online").

It does this by calling SillyTavern's normal generation function directly -
the same thing that happens if you pressed **Send** with an empty message
box. There is **no extra LLM call, no injected out-of-character question**
like "do you think this was a natural pause?", and no meta-commentary. The
model just continues the roleplay as the character, whenever it's triggered.

## Install

1. Copy this whole `proactive-messaging` folder into:
   `SillyTavern/data/<your-handle>/extensions/proactive-messaging`
   (or use SillyTavern's "Install Extension" button and point it at a zip/git
   repo containing these files, if you turn this into one).
2. Restart SillyTavern (or reload the page).
3. Open **Extensions** → find **Proactive Messaging** → enable it.

## Settings

All of these live in the Extensions panel under "Proactive Messaging":

| Setting | What it does |
|---|---|
| Enable proactive messaging | Master on/off switch |
| Idle time before follow-up | How many seconds of silence (after the character's last message) before a follow-up fires |
| Messages needed to count as "flowing" | How many recent messages (from either side) must exist for the conversation to count as "active" |
| Flow window | The time window those recent messages are counted over |
| Cooldown between auto follow-ups | Minimum time between two automatic messages, so it doesn't nag repeatedly |
| Only trigger while this tab is focused | If checked, nothing fires while you've switched to another tab/app |

## How the "no meta-question" behavior works

The extension never asks the LLM to classify the pause, decide if it's
"natural," or answer any planning question. When conditions are met it just
calls the same generation path as clicking Send with nothing typed, so the
model produces whatever it would normally say next in character. If you want
it to behave differently (e.g. sound more like "checking in"), that's a
matter of your character's prompt/personality, not something this extension
scripts in.

## Manual testing

Type `/proactive-test` in the chat box to force an immediate check (it still
respects the "flowing" and cooldown settings, it just skips the idle timer).
Useful for confirming the extension is wired up correctly without waiting
around.

## Notes / things that can vary by SillyTavern version

- This uses the documented, version-stable `getContext()` API
  (`context.generate`, `context.chat`, `eventSource`/`eventTypes`,
  `extensionSettings`) rather than importing internal script files directly,
  per SillyTavern's own extension-writing guidance. That said, SillyTavern
  changes over time, so if it stops working after an update:
  - Open the browser console and look for `[proactive_messaging]` errors.
  - If `context.generate('normal')` starts behaving differently, try
    replacing that single call with:
    `await context.executeSlashCommandsWithOptions('/trigger');`
    (the built-in `/trigger` command is the other common way to make a
    character speak without adding a user message).
- It only fires when the **last message in the chat came from the
  character** (i.e., you're the one "on the clock"). If you're the last
  speaker and the character just hasn't answered yet, this extension leaves
  that alone — that's a normal pending generation, not something to nudge.
- It backs off automatically if you have unsent text sitting in the message
  box, so it won't cut off your typing.
