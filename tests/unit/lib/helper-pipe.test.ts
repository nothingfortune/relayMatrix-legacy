/**
 * The real pipe to PowerShell, with a stand-in for the helper: a script in the same shape
 * (a here-string of C#, Add-Type, try/finally, exit) whose class installs no hook and types
 * nothing. It says ready, echoes each line it is sent as an event, and exits when its stdin
 * closes. What this proves is that `powershell.exe -File` leaves stdin to the C# (and does
 * not read it itself to feed $input), that lines sent in a burst and spaced out all arrive in
 * order, and that closing stdin ends the process. Windows only.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HelperEvent } from "../../../src/lib/helper.js";
import { powershellArgs, processTransport, spawnProcess } from "../../../src/lib/helper-node.js";

const CSHARP = String.raw`using System;
using System.IO;
using System.Text;
using System.Threading;

namespace RelayMatrixProbe
{
    public static class Echo
    {
        static StreamWriter stdout;
        static string Q(string s)
        {
            StringBuilder b = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') b.Append("\\\"");
                else if (c == '\\') b.Append("\\\\");
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }
        public static int Run()
        {
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = true;
            stdout.NewLine = "\n";
            stdout.WriteLine("{\"ev\":\"ready\"}");
            StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = reader.ReadLine()) != null)
                stdout.WriteLine("{\"ev\":\"error\",\"message\":" + Q(line) + "}");
            stdout.WriteLine("{\"ev\":\"stopped\"}");
            return 0;
        }
    }
}
`;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$source = @'",
  CSHARP,
  "'@",
  "Add-Type -TypeDefinition $source",
  "$code = 1",
  "try {",
  "    $code = [RelayMatrixProbe.Echo]::Run()",
  "} finally {",
  "}",
  "exit $code",
  "",
].join("\r\n");

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform !== "win32")("the pipe to a real powershell.exe", () => {
  it("is read by the script and not by the host: ready arrives with stdin open, every line comes back in order, and closing stdin ends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relaymatrix-pipe-"));
    const file = join(dir, "probe.ps1");
    writeFileSync(file, SCRIPT, "utf8");
    const child = spawnProcess("powershell.exe", powershellArgs(file));
    const transport = processTransport(child);
    const events: HelperEvent[] = [];
    let closed = false;
    transport.onEvent((event) => events.push(event));
    transport.onClose(() => {
      closed = true;
    });
    const until = async (done: () => boolean, ms: number, what: string): Promise<void> => {
      const end = Date.now() + ms;
      while (!done() && Date.now() < end) await wait(20);
      if (!done()) throw new Error(`${what}; the process said: ${transport.notes().join(" | ")}`);
    };
    const echoes = (): string[] =>
      events.flatMap((event) => (event.ev === "error" ? [event.message] : []));
    try {
      // 1. Ready, with stdin still open.
      await until(() => events.some((event) => event.ev === "ready"), 60_000, "never got ready");
      expect(closed).toBe(false);

      // 2. A burst, then spaced out. Each is a real protocol line.
      const sent: string[] = [];
      const send = (index: number): void => {
        const command = { cmd: "down", input: { key: `Key${String(index)}` } } as const;
        sent.push(JSON.stringify(command));
        transport.send(command);
      };
      for (let index = 0; index < 300; index++) send(index);
      for (let index = 300; index < 350; index++) {
        send(index);
        await wait(5);
      }
      await until(() => echoes().length >= sent.length, 20_000, "lines went missing");
      expect(echoes()).toEqual(sent);

      // 3. Closing stdin ends it, promptly, and it says so.
      transport.close();
      await until(() => closed, 10_000, "did not exit when stdin closed");
      expect(events.at(-1)).toEqual({ ev: "stopped" });
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
