import { chmod, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

// A provider stand-in executable for the desktop journeys: Node running a
// fixture script. Test fixture only; shipped code never generates executables.
//
// On macOS and Linux it is a shell wrapper. Topsl's structured broker refuses
// `.cmd` and `.bat` launchers, so on Windows it is a small native launcher
// compiled with the C# compiler of the .NET Framework that Windows includes.
// The launcher passes its arguments and standard handles to Node and keeps it
// in a job object, so stopping the launcher also stops Node. On Windows CI
// (29 October 2026) Topsl registered, connected and listed the models of a
// Codex stand-in through it.

const frameworkCompiler = path.join(
  process.env.WINDIR ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);

/**
 * Writes the stand-in to `directory/name` (`name.exe` on Windows) and returns
 * its path. `env` is set for the fixture, as the shell wrapper's prefix does.
 */
export async function standIn({ directory, name, script, env = {} }) {
  const fixture = path.resolve(script);
  if (process.platform !== "win32") {
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const prefix = Object.entries(env)
      .map(([key, value]) => `${key}=${quote(String(value))} `)
      .join("");
    const file = path.join(directory, name);
    await writeFile(
      file,
      `#!/bin/sh\n${prefix}exec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
    );
    await chmod(file, 0o700);
    return file;
  }
  // C# 5: the Framework compiler has no newer language features.
  const literal = (value) => '@"' + String(value).replaceAll('"', '""') + '"';
  const settings = Object.entries(env)
    .map(
      ([key, value]) =>
        `    Environment.SetEnvironmentVariable(${literal(key)}, ${literal(value)});`,
    )
    .join("\n");
  const source = `using System;
using System.Runtime.InteropServices;
using System.Text;

static class StandIn {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x; public int y; public int width; public int height;
    public int xChars; public int yChars; public int fill; public int flags;
    public short show; public short reserved2; public IntPtr reserved3;
    public IntPtr input; public IntPtr output; public IntPtr error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process; public IntPtr thread; public int pid; public int tid; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long perProcessTime; public long perJobTime; public int flags;
    public UIntPtr minWorkingSet; public UIntPtr maxWorkingSet; public int activeProcesses;
    public UIntPtr affinity; public int priority; public int schedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong reads; public ulong writes; public ulong others;
    public ulong readBytes; public ulong writeBytes; public ulong otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory; public UIntPtr jobMemory;
    public UIntPtr peakProcessMemory; public UIntPtr peakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, int flags, IntPtr environment, string directory,
    ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int WaitForSingleObject(IntPtr handle, int ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out int code);

  // The quoting CommandLineToArgvW and the C runtime read back.
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\\t', '"' }) < 0) return value;
    var text = new StringBuilder("\\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\\\') { slashes++; continue; }
      if (c == '"') text.Append('\\\\', slashes * 2 + 1);
      else text.Append('\\\\', slashes);
      slashes = 0;
      text.Append(c);
    }
    text.Append('\\\\', slashes * 2);
    return text.Append('"').ToString();
  }

  static int Main(string[] args) {
${settings}
    string node = ${literal(process.execPath)};
    var command = new StringBuilder(Quote(node) + " " + Quote(${literal(fixture)}));
    foreach (string arg in args) command.Append(" ").Append(Quote(arg));
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    var limits = new ExtendedLimits();
    limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)));
    var startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.flags = 0x100; // STARTF_USESTDHANDLES
    startup.input = GetStdHandle(-10);
    startup.output = GetStdHandle(-11);
    startup.error = GetStdHandle(-12);
    ProcessInfo info;
    // CREATE_SUSPENDED, so Node is in the job before it runs.
    if (!CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero, null, ref startup, out info)) {
      Console.Error.WriteLine("The stand-in could not start Node: error " + Marshal.GetLastWin32Error());
      return 127;
    }
    AssignProcessToJobObject(job, info.process);
    ResumeThread(info.thread);
    WaitForSingleObject(info.process, -1);
    int code;
    GetExitCodeProcess(info.process, out code);
    return code;
  }
}
`;
  const sourceFile = path.join(directory, `${name}.cs`);
  const file = path.join(directory, `${name}.exe`);
  await writeFile(sourceFile, source);
  execFileSync(
    frameworkCompiler,
    ["/nologo", "/optimize", "/target:exe", `/out:${file}`, sourceFile],
    { stdio: "inherit" },
  );
  return file;
}
