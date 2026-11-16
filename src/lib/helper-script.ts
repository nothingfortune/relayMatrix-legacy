/**
 * The Windows helper's own program: PowerShell wrapping a C# class, written to a temp file
 * and run with `powershell.exe -File`. It lives here as text so the repo stays TypeScript
 * and nothing has to be copied at build time.
 *
 * It is a thin bridge and holds no macro logic (see `helper.ts` for the protocol):
 *
 * - a low-level keyboard hook (`WH_KEYBOARD_LL`) on its own thread with a message loop. It
 *   ignores events Windows marks as injected, so it never reacts to its own typing. It
 *   swallows a key only when that key is a registered trigger; every other key passes
 *   through, and a fault in the hook passes the key through too.
 * - an XInput poll for the controller buttons that start a macro. A pad button cannot be
 *   swallowed: the game sees it as well.
 * - typing with `SendInput` and hardware scan codes, because a DirectInput game ignores an
 *   event that has only a virtual key, and mouse buttons with `MOUSEEVENTF_*`.
 *
 * Safety, all of it in the C#:
 * - every key the program put down is released on stop, on an error, on the panic key, on
 *   Ctrl-C and when Node's stdin closes, so the process exits if Node dies; and the cleanup
 *   is idempotent. Windows removes a hook when its process ends, however it ends.
 * - a key held longer than `MAX_HELD_MS` is released, in case Node hangs without dying.
 * - more than `MAX_INJECT_PER_SECOND` key presses in a second end the process.
 * - the panic key (`PANIC_KEY_TEXT`, in Ctrl+Alt+Pause or Ctrl+Alt+Break) releases everything
 *   and ends it. It is not swallowed.
 *
 * The C# is C# 5: Windows PowerShell 5.1's `Add-Type` uses the .NET Framework compiler, so
 * no string interpolation, `?.`, `nameof`, `out var` or expression-bodied members.
 *
 * ASCII only: PowerShell 5.1 reads a file with no byte-order mark in the system's code page.
 *
 * Node-free.
 */

import { HELPER_KEYS, PAD_BITS, PAD_TRIGGER_THRESHOLD } from "./helper-keys.js";

/** A key held this long (ms) without being released is released by the helper itself. */
export const MAX_HELD_MS = 60_000;

/** More key presses than this in one second end the helper. */
export const MAX_INJECT_PER_SECOND = 2_000;

/** How often the controller is read, in ms. */
export const PAD_POLL_MS = 4;

const hex = (value: number): string => `0x${value.toString(16).toUpperCase()}`;

/** The C# that adds every key and pad button of the tables in `helper-keys.ts`. */
function tables(): string {
  const keys = HELPER_KEYS.map(
    (key) =>
      `            AddKey("${key.code}", ${hex(key.scan)}, ${String(key.extended)}, ${hex(key.vk)}, ${String(key.typeable)});`,
  );
  const pads = Object.entries(PAD_BITS).map(
    ([control, bit]) => `            padBits["${control}"] = ${hex(bit)}u;`,
  );
  return [...keys, ...pads].join("\n");
}

const CSHARP = String.raw`using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace RelayMatrix
{
    public static class Helper
    {
        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_KEYUP = 0x0101;
        const int WM_SYSKEYDOWN = 0x0104;
        const int WM_SYSKEYUP = 0x0105;
        const uint WM_QUIT = 0x0012;
        const uint WM_USER = 0x0400;
        const uint LLKHF_EXTENDED = 0x01;
        const uint LLKHF_INJECTED = 0x10;
        const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const uint KEYEVENTF_SCANCODE = 0x0008;
        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        const uint VK_CANCEL = 0x03;
        const uint VK_PAUSE = 0x13;
        const int VK_CONTROL = 0x11;
        const int VK_MENU = 0x12;
        const long MAX_HELD_MS = /*MAXHELD*/;
        const int MAX_INJECT_PER_SECOND = /*MAXINJECT*/;
        const int PAD_POLL_MS = /*PADPOLL*/;
        const int PAD_TRIGGER_THRESHOLD = /*PADTHRESHOLD*/;
        const uint PAD_LT = 0x10000;
        const uint PAD_RT = 0x20000;

        delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public UIntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public UIntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT
        {
            public uint type;
            public InputUnion U;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_GAMEPAD
        {
            public ushort wButtons;
            public byte bLeftTrigger;
            public byte bRightTrigger;
            public short sThumbLX;
            public short sThumbLY;
            public short sThumbRX;
            public short sThumbRY;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_STATE
        {
            public uint dwPacketNumber;
            public XINPUT_GAMEPAD Gamepad;
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr GetModuleHandle(string lpModuleName);
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);
        [DllImport("user32.dll")]
        static extern bool TranslateMessage(ref MSG lpMsg);
        [DllImport("user32.dll")]
        static extern IntPtr DispatchMessage(ref MSG lpMsg);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool PostThreadMessage(uint idThread, uint Msg, UIntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
        static extern uint XInputGetState14(uint dwUserIndex, out XINPUT_STATE pState);
        [DllImport("xinput1_3.dll", EntryPoint = "XInputGetState")]
        static extern uint XInputGetState13(uint dwUserIndex, out XINPUT_STATE pState);

        sealed class KeyInfo
        {
            public string Code;
            public uint Scan;
            public bool Ext;
            public uint Vk;
            public bool Typeable;
        }

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly Stopwatch Clock = Stopwatch.StartNew();
        static readonly Dictionary<string, KeyInfo> byCode = new Dictionary<string, KeyInfo>();
        static readonly Dictionary<uint, KeyInfo> byScan = new Dictionary<uint, KeyInfo>();
        static readonly Dictionary<uint, KeyInfo> byVk = new Dictionary<uint, KeyInfo>();
        static readonly Dictionary<string, uint> padBits = new Dictionary<string, uint>();

        // What is being watched. Replaced whole, never edited, so the hook reads it without a lock.
        static volatile Dictionary<string, List<string>> keyTriggers = new Dictionary<string, List<string>>();
        static volatile Dictionary<string, uint> padWatch = new Dictionary<string, uint>();
        // Triggers whose down was swallowed, by key, and who was told. Touched only by the hook thread.
        static readonly Dictionary<string, List<string>> held = new Dictionary<string, List<string>>();
        // Everything this process has put down, by name, and when. Under pressedGate.
        static readonly Dictionary<string, long> pressed = new Dictionary<string, long>();
        static readonly object pressedGate = new object();
        static readonly BlockingCollection<string> outbox = new BlockingCollection<string>();
        static readonly ManualResetEvent done = new ManualResetEvent(false);
        static readonly ManualResetEvent hookReady = new ManualResetEvent(false);

        static LowLevelKeyboardProc hookProc = HookCallback;
        static IntPtr hook = IntPtr.Zero;
        static uint hookThreadId = 0;
        static Thread hookThread;
        static Thread writerThread;
        static StreamWriter stdout;
        static volatile bool stopping = false;
        static int exitCode = 0;
        static int shuttingDown = 0;
        static int cleaned = 0;
        static int xinputVersion = 14;
        static volatile bool xinputBroken = false;
        static long windowStart = 0;
        static int windowCount = 0;
        static readonly object windowGate = new object();
        static bool sendWarned = false;

        static void AddKey(string code, uint scan, bool ext, uint vk, bool typeable)
        {
            KeyInfo k = new KeyInfo();
            k.Code = code;
            k.Scan = scan;
            k.Ext = ext;
            k.Vk = vk;
            k.Typeable = typeable;
            byCode[code] = k;
            if (typeable) byScan[(ext ? 0x100u : 0u) | scan] = k;
            if (!byVk.ContainsKey(vk)) byVk[vk] = k;
        }

        static void InitTables()
        {
/*TABLES*/
        }

        // ---- output: one JSON object per line, written by one thread

        static string Q(string s)
        {
            StringBuilder b = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') b.Append("\\\"");
                else if (c == '\\') b.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }

        static string Ev(string ev) { return "{\"ev\":" + Q(ev) + "}"; }
        static string Ev(string ev, string device, string input)
        {
            return "{\"ev\":" + Q(ev) + ",\"device\":" + Q(device) + ",\"input\":" + Q(input) + "}";
        }
        static string Err(string message) { return "{\"ev\":\"error\",\"message\":" + Q(message) + "}"; }

        static void Emit(string line)
        {
            try { if (!outbox.IsAddingCompleted) outbox.Add(line); }
            catch (InvalidOperationException) { }
        }

        static void WriterLoop()
        {
            try
            {
                foreach (string line in outbox.GetConsumingEnumerable()) stdout.WriteLine(line);
            }
            catch (Exception)
            {
                Shutdown(1);
            }
        }

        // ---- typing

        static bool WithinRate()
        {
            lock (windowGate)
            {
                long now = Clock.ElapsedMilliseconds;
                if (now - windowStart >= 1000) { windowStart = now; windowCount = 0; }
                windowCount++;
                return windowCount <= MAX_INJECT_PER_SECOND;
            }
        }

        static void Inject(INPUT[] input)
        {
            uint sent = SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
            if (sent != 1 && !sendWarned)
            {
                sendWarned = true;
                Emit(Err("SendInput was refused: a game running as administrator needs the helper run as administrator too"));
            }
        }

        static void SendKey(KeyInfo k, bool up)
        {
            INPUT[] a = new INPUT[1];
            a[0].type = 1;
            a[0].U.ki.wVk = 0;
            a[0].U.ki.wScan = (ushort)k.Scan;
            uint flags = KEYEVENTF_SCANCODE;
            if (up) flags |= KEYEVENTF_KEYUP;
            if (k.Ext) flags |= KEYEVENTF_EXTENDEDKEY;
            a[0].U.ki.dwFlags = flags;
            Inject(a);
        }

        static void SendMouse(string button, bool up)
        {
            uint flag;
            if (button == "left") flag = up ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_LEFTDOWN;
            else if (button == "right") flag = up ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_RIGHTDOWN;
            else flag = up ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_MIDDLEDOWN;
            INPUT[] a = new INPUT[1];
            a[0].type = 0;
            a[0].U.mi.dwFlags = flag;
            Inject(a);
        }

        static void Press(string name, bool up)
        {
            string kind = name.Substring(0, name.IndexOf(':'));
            string what = name.Substring(name.IndexOf(':') + 1);
            if (kind == "key") SendKey(byCode[what], up);
            else SendMouse(what, up);
        }

        static void TypeCommand(Dictionary<string, object> msg, bool up)
        {
            Dictionary<string, object> input = msg.ContainsKey("input") ? msg["input"] as Dictionary<string, object> : null;
            if (input == null) { Emit(Err("down and up need an input")); return; }
            string name;
            if (input.ContainsKey("key"))
            {
                string code = Convert.ToString(input["key"]);
                KeyInfo k;
                if (!byCode.TryGetValue(code, out k) || !k.Typeable)
                {
                    Emit(Err("cannot type key " + code));
                    return;
                }
                name = "key:" + code;
            }
            else if (input.ContainsKey("mouse"))
            {
                string button = Convert.ToString(input["mouse"]);
                if (button != "left" && button != "middle" && button != "right")
                {
                    Emit(Err("cannot type mouse " + button));
                    return;
                }
                name = "mouse:" + button;
            }
            else { Emit(Err("down and up need a key or a mouse button")); return; }

            if (!up && !WithinRate())
            {
                Emit(Err("runaway: too many key presses in a second"));
                Shutdown(3);
                return;
            }
            lock (pressedGate)
            {
                // Once shutdown has begun, nothing more goes down: ReleaseAll has run or is about
                // to, and a key pressed after it would stay down when this process exits. stopping
                // is set before ReleaseAll takes this lock, so checking it here closes the race.
                if (!up && stopping) return;
                if (up) pressed.Remove(name);
                else if (!pressed.ContainsKey(name)) pressed[name] = Clock.ElapsedMilliseconds;
                Press(name, up);
            }
        }

        /// <summary>Lift everything this process put down.</summary>
        static void ReleaseAll()
        {
            lock (pressedGate)
            {
                List<string> names = new List<string>(pressed.Keys);
                names.Reverse();
                foreach (string name in names)
                {
                    try { Press(name, true); } catch (Exception) { }
                }
                pressed.Clear();
            }
        }

        static void WatchdogLoop()
        {
            while (!stopping)
            {
                Thread.Sleep(500);
                lock (pressedGate)
                {
                    long now = Clock.ElapsedMilliseconds;
                    List<string> stuck = new List<string>();
                    foreach (KeyValuePair<string, long> kv in pressed)
                        if (now - kv.Value > MAX_HELD_MS) stuck.Add(kv.Key);
                    foreach (string name in stuck)
                    {
                        pressed.Remove(name);
                        try { Press(name, true); } catch (Exception) { }
                        Emit(Err("released " + name + ": it was held for over " + (MAX_HELD_MS / 1000).ToString() + " s"));
                    }
                }
            }
        }

        // ---- the keyboard hook

        static string CodeOf(KBDLLHOOKSTRUCT k)
        {
            KeyInfo info;
            uint ext = (k.flags & LLKHF_EXTENDED) != 0 ? 0x100u : 0u;
            if (byScan.TryGetValue(ext | (k.scanCode & 0xFF), out info)) return info.Code;
            if (byVk.TryGetValue(k.vkCode, out info)) return info.Code;
            return null;
        }

        static bool Down(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        /// <summary>True when the key is a trigger and is to be swallowed.</summary>
        static bool HandleTrigger(string code, bool down)
        {
            List<string> devices;
            if (down)
            {
                // A held trigger repeats its down. It was swallowed once; swallow the repeats and say nothing.
                if (held.ContainsKey(code)) return true;
                if (!keyTriggers.TryGetValue(code, out devices)) return false;
                held[code] = devices;
                foreach (string d in devices) Emit(Ev("down", d, code));
                return true;
            }
            // The up of a key whose down was swallowed is swallowed, whatever is watched now.
            if (!held.TryGetValue(code, out devices)) return false;
            held.Remove(code);
            foreach (string d in devices) Emit(Ev("up", d, code));
            return true;
        }

        static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                try
                {
                    KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    if ((k.flags & LLKHF_INJECTED) == 0)
                    {
                        int m = wParam.ToInt32();
                        bool isDown = m == WM_KEYDOWN || m == WM_SYSKEYDOWN;
                        bool isUp = m == WM_KEYUP || m == WM_SYSKEYUP;
                        if (isDown || isUp)
                        {
                            // The panic key. Ctrl+Pause arrives as VK_CANCEL. It is passed through, not swallowed.
                            if (isDown && (k.vkCode == VK_PAUSE || k.vkCode == VK_CANCEL) && Down(VK_CONTROL) && Down(VK_MENU))
                                ThreadPool.QueueUserWorkItem(delegate(object state) { Emit(Ev("panic")); Shutdown(0); });
                            string code = CodeOf(k);
                            if (code != null && HandleTrigger(code, isDown)) return (IntPtr)1;
                        }
                    }
                }
                catch (Exception)
                {
                    // Fail open: a fault here lets the key through.
                }
            }
            return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        static void HookThread()
        {
            hookThreadId = GetCurrentThreadId();
            MSG msg;
            // Makes this thread's message queue exist, so a WM_QUIT posted to it cannot be lost.
            PeekMessage(out msg, IntPtr.Zero, WM_USER, WM_USER, 0);
            try
            {
                using (Process p = Process.GetCurrentProcess())
                using (ProcessModule m = p.MainModule)
                    hook = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, GetModuleHandle(m.ModuleName), 0);
            }
            catch (Exception e)
            {
                Emit(Err("keyboard hook: " + e.Message));
            }
            hookReady.Set();
            if (hook == IntPtr.Zero) return;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }

        // ---- the controller

        static bool ReadPad(uint index, out XINPUT_STATE state)
        {
            state = new XINPUT_STATE();
            try
            {
                return (xinputVersion == 14 ? XInputGetState14(index, out state) : XInputGetState13(index, out state)) == 0;
            }
            catch (DllNotFoundException)
            {
                if (xinputVersion == 14) { xinputVersion = 13; return false; }
                xinputBroken = true;
                Emit(Err("XInput is not available: controller buttons are not read"));
                return false;
            }
            catch (EntryPointNotFoundException)
            {
                xinputBroken = true;
                Emit(Err("XInput is not available: controller buttons are not read"));
                return false;
            }
        }

        static void PadLoop()
        {
            uint previous = 0;
            long[] retryAt = new long[4];
            while (!stopping)
            {
                Dictionary<string, uint> watch = padWatch;
                if (watch.Count == 0 || xinputBroken) { Thread.Sleep(50); continue; }
                uint mask = 0;
                long now = Clock.ElapsedMilliseconds;
                for (uint i = 0; i < 4; i++)
                {
                    // A slot with no controller is slow to ask: look again once a second.
                    if (now < retryAt[i]) continue;
                    XINPUT_STATE s;
                    if (!ReadPad(i, out s)) { retryAt[i] = now + 1000; continue; }
                    mask |= s.Gamepad.wButtons;
                    if (s.Gamepad.bLeftTrigger > PAD_TRIGGER_THRESHOLD) mask |= PAD_LT;
                    if (s.Gamepad.bRightTrigger > PAD_TRIGGER_THRESHOLD) mask |= PAD_RT;
                }
                uint changed = mask ^ previous;
                if (changed != 0)
                {
                    foreach (KeyValuePair<string, uint> kv in watch)
                        if ((changed & kv.Value) != 0)
                            Emit(Ev((mask & kv.Value) != 0 ? "down" : "up", "pad", kv.Key));
                    previous = mask;
                }
                Thread.Sleep(PAD_POLL_MS);
            }
        }

        // ---- commands from Node

        static void Watch(Dictionary<string, object> msg)
        {
            Dictionary<string, List<string>> keys = new Dictionary<string, List<string>>();
            Dictionary<string, uint> pads = new Dictionary<string, uint>();
            IEnumerable list = msg.ContainsKey("triggers") ? msg["triggers"] as IEnumerable : null;
            if (list != null)
            {
                foreach (object item in list)
                {
                    Dictionary<string, object> t = item as Dictionary<string, object>;
                    if (t == null || !t.ContainsKey("device") || !t.ContainsKey("input")) continue;
                    string device = Convert.ToString(t["device"]);
                    string input = Convert.ToString(t["input"]);
                    if (device == "pad")
                    {
                        uint bit;
                        if (padBits.TryGetValue(input, out bit)) pads[input] = bit;
                        else Emit(Err("cannot read controller button " + input));
                    }
                    else if (device == "azeron" || device == "keyboard")
                    {
                        if (!byCode.ContainsKey(input)) { Emit(Err("cannot read key " + input)); continue; }
                        List<string> devices;
                        if (!keys.TryGetValue(input, out devices)) { devices = new List<string>(); keys[input] = devices; }
                        if (!devices.Contains(device)) devices.Add(device);
                    }
                }
            }
            keyTriggers = keys;
            padWatch = pads;
        }

        static void Handle(string line)
        {
            line = line.Replace(((char)0xFEFF).ToString(), "").Trim();
            if (line.Length == 0) return;
            Dictionary<string, object> msg = null;
            try { msg = Json.DeserializeObject(line) as Dictionary<string, object>; }
            catch (Exception e) { Emit(Err("bad command: " + e.Message)); return; }
            if (msg == null || !msg.ContainsKey("cmd")) { Emit(Err("bad command")); return; }
            string cmd = Convert.ToString(msg["cmd"]);
            if (cmd == "watch") Watch(msg);
            else if (cmd == "down") TypeCommand(msg, false);
            else if (cmd == "up") TypeCommand(msg, true);
            else if (cmd == "stop") Shutdown(0);
            else Emit(Err("unknown command " + cmd));
        }

        static void ReaderLoop()
        {
            try
            {
                StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = reader.ReadLine()) != null) Handle(line);
                // Node closed our stdin, or died: release everything and go.
                Shutdown(0);
            }
            catch (Exception)
            {
                Shutdown(1);
            }
        }

        // ---- start and stop

        static void Shutdown(int code)
        {
            if (Interlocked.Exchange(ref shuttingDown, 1) != 0) return;
            exitCode = code;
            stopping = true;
            done.Set();
        }

        public static int Run()
        {
            InitTables();
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = true;
            stdout.NewLine = "\n";
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; Shutdown(0); };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                try { Cleanup(); } catch (Exception) { }
            };
            writerThread = new Thread(WriterLoop);
            writerThread.IsBackground = true;
            writerThread.Start();
            hookThread = new Thread(HookThread);
            hookThread.IsBackground = true;
            hookThread.Start();
            if (!hookReady.WaitOne(5000) || hook == IntPtr.Zero)
            {
                Emit(Err("the keyboard hook could not be installed"));
                return 2;
            }
            Thread pad = new Thread(PadLoop);
            pad.IsBackground = true;
            pad.Start();
            Thread watchdog = new Thread(WatchdogLoop);
            watchdog.IsBackground = true;
            watchdog.Start();
            Thread reader = new Thread(ReaderLoop);
            reader.IsBackground = true;
            reader.Start();
            Emit(Ev("ready"));
            done.WaitOne();
            return exitCode;
        }

        /// <summary>Release every key, remove the hook, say goodbye. Safe to call any number of times.</summary>
        public static void Cleanup()
        {
            if (Interlocked.Exchange(ref cleaned, 1) != 0) return;
            stopping = true;
            try { ReleaseAll(); } catch (Exception) { }
            try
            {
                if (hookThreadId != 0) PostThreadMessage(hookThreadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                if (hookThread != null && !hookThread.Join(1500) && hook != IntPtr.Zero)
                {
                    UnhookWindowsHookEx(hook);
                    hook = IntPtr.Zero;
                }
            }
            catch (Exception) { }
            Emit(Ev("stopped"));
            try
            {
                outbox.CompleteAdding();
                if (writerThread != null) writerThread.Join(1500);
            }
            catch (Exception) { }
        }
    }
}
`;

/** The C# class, with the key and controller tables of `helper-keys.ts` written in. */
export function helperCSharp(): string {
  const replacements: [string, string][] = [
    ["/*TABLES*/", tables()],
    ["/*MAXHELD*/", String(MAX_HELD_MS)],
    ["/*MAXINJECT*/", String(MAX_INJECT_PER_SECOND)],
    ["/*PADPOLL*/", String(PAD_POLL_MS)],
    ["/*PADTHRESHOLD*/", String(PAD_TRIGGER_THRESHOLD)],
  ];
  let text = CSHARP;
  for (const [marker, value] of replacements) text = text.split(marker).join(value);
  return text;
}

/**
 * The whole PowerShell script. The C# is in a single-quoted here-string, so PowerShell
 * touches nothing in it.
 */
export function helperScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$source = @'",
    helperCSharp(),
    "'@",
    "Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Web.Extensions'",
    "$code = 1",
    "try {",
    "    $code = [RelayMatrix.Helper]::Run()",
    "} catch {",
    "    [Console]::Error.WriteLine($_.Exception.Message)",
    "} finally {",
    "    [RelayMatrix.Helper]::Cleanup()",
    "}",
    "exit $code",
    "",
  ].join("\r\n");
}
