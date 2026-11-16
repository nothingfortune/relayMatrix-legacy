# Macros

Press one button, on an Azeron, a keyboard or a controller, and the game receives a list of
keys: `A`, then `B`, then `C`.

The units store none of it (a macro key is written as an empty record and the Azeron app
types the steps on the PC), so a small helper program on the PC does the typing.

## What you write

A macro is the list of keys the game should get, in the game's `macros.yaml`, keyed by the id
of the action that starts it:

```yaml
macros:
  abc: [KeyA, KeyB, KeyC]

  quick_heal:
    repeat: true # run again while the button is held
    hold: 40 # how long each key is down (default 30 ms)
    gap: 20 # the pause between keys (default 30 ms)
    steps:
      - { action: reload } # the key the game has reload on
      - KeyH
      - { wait: 50 } # only when you want a longer pause
      - { down: ShiftLeft } # hold a key across the next steps
      - MouseLeft
      - { up: ShiftLeft }
```

A bare key is a tap. Timing has defaults, so the common case is just the list.

## What starts it

The macro's action says which buttons start it, in the fields an action already has. Any or
all:

| Device     | Field | What it is                                                              |
| ---------- | ----- | ----------------------------------------------------------------------- |
| Azeron     | `key` | A keypad control sends a trigger key, F13-F24, handed out for you       |
| Keyboard   | `kbm` | One plain key (no modifier, no mouse button), which the helper swallows |
| Controller | `pad` | A button or trigger (not a stick direction), which the helper reads     |

## Where it runs

1. `azeron build` compiles `macros.yaml` and the actions into `dist/<game>/macros.json`: per
   macro, every button that starts it and the concrete down / up / wait operations.
   Committed, and a fixed point like the rest of `dist/`.
2. The helper (a Windows process) watches for those buttons, swallows a keyboard one, and
   types the operations. Off unless a game turns it on.

Why a trigger key for the Azeron and not the unit's own press reports: the unit only reports
them (`BTN_POS`, 0x39) with the app's live view open, and no capture of what asks for them
exists. A trigger key needs neither that nor exclusive access, and does not fight the Azeron
app for the channel.

Limits, so a typo cannot lock the keyboard: 64 steps, 10 s per wait, 5 s per hold, 512
operations once expanded. Modifiers and the three mouse buttons can be typed; the wheel and
the side buttons cannot.

## Checks

- `macro-invalid` (error): the macro does not resolve: no such action, an action with no key in
  the game, a binding that is not a key, a limit passed, a repeat with no wait in it.
- `macro-trigger` (error): the action has no button; its keypad key is not F13-F24 or is sent
  with a modifier; its keyboard key is not one plain key; its controller control is not a
  button; or two macros share a button.
- `key-collision` and `kbm-collision` already cover a button shared with another live action.

## Three PRs

1. **Core** (`feat/macros-core`): the model, trigger allocation, the checks, the compiled
   `macros.json` under the gate, and the runner against a fake. Nothing runs on a PC.
2. **Editor**: a Macros panel. Write the key list, pick which buttons start it; the keypad
   trigger is wired for you. A macro's action must be routed to `wireTrigger`, not the
   general key pool, or it would be given a key a game might use.
3. **Helper**: the Windows process (PowerShell + C#: a low-level keyboard hook, an XInput
   reader for controller buttons, and `SendInput`), `azeron helper start | stop | status`,
   per-game opt-in, and the anti-cheat warning. Injected input is flagged by Windows, and some
   anti-cheat treats it as cheating: check a game before turning it on.

## Open

- A DirectInput game may read scan codes, not virtual keys: the helper sends scan codes, and
  this needs a real game to confirm.
- The helper must ignore its own injected events and run a macro once however long its button
  is held, unless it repeats.
- The keyboard trigger is swallowed so the game never sees it; the helper has to be running
  for that key to do anything else.
