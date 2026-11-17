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
3. **Helper** (`feat/macros-helper`, built; see below): the Windows process, `azeron helper
start | stop | status`, per-game opt-in, and the anti-cheat warning. Injected input is
   flagged by Windows, and some anti-cheat treats it as cheating: check a game before turning
   it on.

## The helper

`docs/guides/macro-helper.md` says how to turn it on and how to test it by hand.

A thin I/O bridge in two halves. The macro logic stays in TypeScript.

- **Bridge and session** (`src/lib/helper.ts`, node-free). Lines of JSON between Node and the
  Windows process. It says `ready`, `down`/`up` (a trigger's device and input), `error`,
  `panic` and `stopped`; it is told `watch` (the runner's `triggers()`), `down`/`up` (a key or
  mouse button to type) and `stop`. `HelperSession` wires a `MacroRunner` to a
  `HelperTransport`: the runner's `MacroIo` becomes commands, its sleeps use an injected clock
  (and end early on stop), a held trigger's repeated downs are ignored, and a transport that
  dies or a `panic` stops every macro. Tests use a fake transport and a fake clock.
- **The Windows process** (`src/lib/helper-script.ts`: PowerShell wrapping a C# 5 class,
  written to a temp file and run with `powershell.exe -File`). A `WH_KEYBOARD_LL` hook on its
  own thread with a message loop; it ignores injected events, swallows a key only when it is a
  registered trigger (and the up of a down it swallowed), and fails open. XInput
  (`xinput1_4.dll`) is polled every 4 ms for the registered controller buttons; a pad button
  is read, not swallowed. Keys are typed with `SendInput` and scan codes
  (`KEYEVENTF_SCANCODE`, with the extended flag), mouse buttons with `MOUSEEVENTF_*`. The key
  table (`helper-keys.ts`) is the one source for both the script and the tests; scan codes
  were checked against `MapVirtualKey` on a Windows machine, F13-F24 included (0x64-0x6e, then
  0x76). Pause, Print Screen and Num Lock are readable as triggers but never typed: their scan
  sequences are not one code.
- **Safety.** Every key the process put down is released on stop, on an error, on Ctrl-C, on
  the panic key and when Node's stdin closes (so it exits if Node dies); the cleanup runs once
  and from every one of those. A key held over a minute is released; over 2000 presses a
  second ends the process, and the session has its own cap (1000 downs a second). **The panic
  key is Ctrl+Alt+Pause** (also Ctrl+Alt+Break): it releases everything and stops the helper,
  and is not swallowed.
- **Running it** (`helper-tasks.ts`, `helper-node.ts`, `helper-cli.ts`). `start` checks, in
  order: the game's `game.yaml` has `macros: {helper: true}`, it has macros, `dist/<game>/macros.json`
  exists and equals what the macros compile to now, the helper can type all of it, and this is
  Windows or WSL. It then prints the anti-cheat warning, asks for a yes (or takes `--yes`;
  refuses with no terminal and no `--yes`), and runs in the foreground: Ctrl-C stops it, which
  is simpler than a background service and means it cannot be forgotten. `status` and
  `stop` work through `logs/helper.json` (a heartbeat every 2 s) and `logs/helper.stop` (a
  request the helper looks for every half second), never a process id, so they work across
  WSL and PowerShell and cannot end an unrelated program.
  From WSL the script is written under the Windows temp folder (reached through `/mnt`) and
  PowerShell is given its Windows spelling.

## Open

- **Nothing here has run against a real hook, game or controller.** The text is checked (it
  parses and the C# compiles under Windows PowerShell 5.1, and the protocol is run against a
  fake process); no test installs a hook or types a key. `docs/guides/macro-helper.md` is the
  hand test.
- A DirectInput game may read scan codes, not virtual keys: the helper sends scan codes, and
  this needs a real game to confirm.
- The keyboard trigger is swallowed so the game never sees it; the helper has to be running
  for that key to do anything else.
- A game running as administrator ignores a helper that is not (UIPI), and the hook does not
  see its keys either. The helper says so when `SendInput` is refused.
- Closing the terminal window ends both processes at once; whether PowerShell gets to release
  its keys first is untested.
- The stdin lifeline and the line protocol were run against a real `powershell.exe` with a
  stand-in script (no hook, no input): `-File` leaves stdin to the C#, 350 lines came back in
  order, and closing stdin ended it (`tests/unit/lib/helper-pipe.test.ts`, Windows only).
- WSL: the process is started through `powershell.exe` interop. Whether closing stdin reaches
  it when Node is killed is untested.
- The opt-in is a hand edit of `game.yaml`; the editor could offer it beside the macros panel.
