# The macro helper

A small Windows process that types a macro's keys. Read `docs/plans/macros.md` for what a macro
is; this is how to run the helper and how to check it by hand.

**Read this first.** The helper types with `SendInput`. Windows marks that input as injected,
and some anti-cheat reads it as cheating. Check the game's rules before turning it on. It is
off for every game until the game's `game.yaml` says so.

## Turn it on for a game

1. In the game's `game.yaml`:

   ```yaml
   macros:
     helper: true
   ```

2. Write the macros (`macros.yaml`) and give each action its buttons (`key` F13-F24, `kbm`,
   `pad`).
3. `azeron build`. The helper refuses a program that is missing or older than `macros.yaml`.
4. `azeron helper start <game>`. It prints the warning, asks (or take `--yes`), and runs in
   that terminal. Leave it open while you play.

From PowerShell or WSL; elsewhere it says it runs on Windows only.

## Stop it

- Ctrl-C in its terminal.
- `azeron helper stop` from another terminal. It asks the helper to go and waits; it never
  kills a process. `azeron helper status` says whether one runs (exit 0) or not (exit 1).
- **Ctrl+Alt+Pause** (also Ctrl+Alt+Break) anywhere: it releases every key the helper put down
  and ends it. The key itself is not swallowed.
- Closing the terminal, or Node dying: the helper sees its input close, releases every key and
  exits. Windows removes its keyboard hook when the process ends, however it ends.

## What it does to your keyboard

- It swallows a key only when that key is a trigger of the game's macros: the F13-F24 key a
  keypad control sends, and any plain key a macro names as its `kbm`. Every other key goes
  through untouched, and a fault in the hook lets the key through.
- A controller button (`pad`) is read, not swallowed: the game sees it too.
- A held trigger runs its macro once (a `repeat` macro runs while held).
- Keys it types are marked injected, and it ignores those, so it never starts a macro with its
  own typing.
- A key it has held for a minute is released; more than 2000 key presses in a second end it.

## Check it by hand

Do these in order, with nothing important open. Stop at the first thing that does not match.

1. **Compile and start.** `azeron helper start <game> --yes`. Expect `helper on: <game>, N
macro(s). Ctrl+Alt+Pause stops it, as does Ctrl-C.` within a few seconds. An error here is
   PowerShell's own, printed under `the helper did not start`.
2. **Status.** In a second terminal, `azeron helper status` says `running: ...`.
3. **A keyboard trigger.** Open Notepad. Press a macro's keyboard key: Notepad types the
   macro's keys, not the trigger. The terminal prints `keyboard <Key>`.
4. **A keyboard key that is not a trigger** types as usual.
5. **An Azeron trigger.** Press the keypad control. Same, and the trigger key (F13...) does not
   reach Notepad.
6. **A controller button**, if you have one: the macro types and the game also sees the button.
7. **The game.** In a game that reads scan codes (a DirectInput one), the macro's keys arrive. This is the open
   question in the plan: scan codes are what the helper sends, and only a real game confirms
   them. If a game ignores them, say which.
8. **Held keys.** Run a macro with a long `down: ShiftLeft` ... `up: ShiftLeft`, and press
   Ctrl+Alt+Pause in the middle. Shift must be up afterwards (type a letter in Notepad).
9. **Stop paths.** Each of Ctrl-C, `azeron helper stop`, Ctrl+Alt+Pause and closing the
   terminal window ends it, and the keyboard is normal after each. `azeron helper status`
   then says `not running`.
10. **A game running as administrator** ignores the helper's typing (Windows will not let
    a normal process type into it). Run the terminal as administrator to match it.

If a key ever sticks, press and release it. If the keyboard seems dead, Ctrl+Alt+Pause; failing
that, end the `powershell.exe` the helper started from Task Manager. A hook has no life beyond
its process.

## Where things are

| Path                       | What                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `src/lib/helper.ts`        | The protocol and `HelperSession` (the runner behind a pipe).  |
| `src/lib/helper-script.ts` | The PowerShell and C# that run on Windows, as text.           |
| `src/lib/helper-keys.ts`   | Scan codes, virtual keys and XInput bits. One table.          |
| `src/lib/helper-node.ts`   | Starting the process, its pipes, the temp file, the run loop. |
| `src/lib/helper-tasks.ts`  | Opt-in, the stale check, and the state file for status/stop.  |
| `logs/helper.json`         | A running helper's heartbeat. Not committed.                  |
| `logs/helper.stop`         | A request to stop; the helper removes it.                     |
