/**
 * The helper's script, as text. What these tests never do is run it: nothing here installs
 * a keyboard hook or types a key. On Windows two of them hand the text to PowerShell to be
 * parsed and the C# to be compiled, which executes none of it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HELPER_KEYS, PAD_BITS } from "../../../src/lib/helper-keys.js";
import {
  helperCSharp,
  helperScript,
  MAX_HELD_MS,
  MAX_INJECT_PER_SECOND,
} from "../../../src/lib/helper-script.js";

const windows = process.platform === "win32";

describe("the helper script's text", () => {
  const script = helperScript();
  const csharp = helperCSharp();

  it("is ASCII, because PowerShell 5.1 reads a file with no byte-order mark in the system code page", () => {
    // eslint-disable-next-line no-control-regex -- the point is to find any byte past 0x7f
    expect(script).toMatch(/^[\x00-\x7f]*$/);
  });

  it("has every marker filled in", () => {
    expect(csharp).not.toMatch(/\/\*[A-Z]+\*\//);
    expect(csharp).toContain(`MAX_HELD_MS = ${String(MAX_HELD_MS)}`);
    expect(csharp).toContain(`MAX_INJECT_PER_SECOND = ${String(MAX_INJECT_PER_SECOND)}`);
  });

  it("writes every key and every controller button from the tables, once", () => {
    for (const key of HELPER_KEYS) {
      const rows = csharp.split(`AddKey("${key.code}", `).length - 1;
      expect(rows, key.code).toBe(1);
    }
    for (const control of Object.keys(PAD_BITS)) {
      expect(csharp).toContain(`padBits["${control}"] = `);
    }
  });

  it("closes the here-string where PowerShell looks for it, and nowhere else", () => {
    const lines = script.split("\r\n");
    expect(lines.filter((line) => line.startsWith("'@"))).toEqual(["'@"]);
    expect(lines.filter((line) => line.startsWith("@'"))).toEqual([]);
    expect(script).toContain("$source = @'\r\n");
  });

  it("uses no C# newer than the compiler Windows PowerShell 5.1 has (C# 5)", () => {
    expect(csharp).not.toMatch(/\$"/); // string interpolation
    expect(csharp).not.toMatch(/\?\./); // null-conditional
    expect(csharp).not.toMatch(/\bnameof\b/);
    expect(csharp).not.toMatch(/out var\b/);
    expect(csharp).not.toMatch(/\)\s*=>\s*[^{]/); // expression-bodied members and lambdas
  });

  it("releases everything, whichever way it ends", () => {
    // The cleanup is idempotent and runs from the script's finally; the paths into it are
    // stop, a closed stdin, Ctrl-C, an unhandled error and the panic key.
    expect(script).toMatch(/finally \{\r\n\s+\[RelayMatrix.Helper\]::Cleanup\(\)/);
    expect(csharp).toContain("Interlocked.Exchange(ref cleaned, 1)");
    expect(csharp).toContain("Console.CancelKeyPress");
    expect(csharp).toContain("UnhandledException");
    expect(csharp).toContain("// Node closed our stdin, or died");
    expect(csharp).toContain("VK_CANCEL");
  });

  it("ignores injected events and never swallows without a registered trigger", () => {
    expect(csharp).toContain("(k.flags & LLKHF_INJECTED) == 0");
    expect(csharp).toContain("if (!keyTriggers.TryGetValue(code, out devices)) return false;");
    // A fault in the hook lets the key through.
    expect(csharp).toMatch(/catch \(Exception\)\s*\{\s*\/\/ Fail open/);
  });

  it("types scan codes, not virtual keys", () => {
    expect(csharp).toContain("a[0].U.ki.wVk = 0;");
    expect(csharp).toContain("uint flags = KEYEVENTF_SCANCODE;");
  });
});

describe.skipIf(!windows)("the helper script, checked by PowerShell without running it", () => {
  const powershell = (args: string[]): { out: string; status: number | null } => {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
      { encoding: "utf8", timeout: 120_000 },
    );
    return { out: `${result.stdout}${result.stderr}`, status: result.status };
  };

  it("parses with no errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "relaymatrix-parse-"));
    try {
      const file = join(dir, "helper.ps1");
      writeFileSync(file, helperScript(), "utf8");
      // The parser reads the text. It does not run it.
      const { out, status } = powershell([
        "-Command",
        `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); if ($e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 1 } else { 'no errors' }`,
      ]);
      expect(out.trim()).toBe("no errors");
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compiles as C# 5, and does nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "relaymatrix-compile-"));
    try {
      const file = join(dir, "helper.cs");
      writeFileSync(file, helperCSharp(), "utf8");
      // Add-Type compiles. Looking a type up by name runs no code of it: no hook, no input.
      const { out, status } = powershell([
        "-Command",
        `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${file}') -ReferencedAssemblies 'System.Web.Extensions'; $t = [RelayMatrix.Helper]; $t.GetMethod('Run').Name + ',' + $t.GetMethod('Cleanup').Name`,
      ]);
      expect(out.trim()).toBe("Run,Cleanup");
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
