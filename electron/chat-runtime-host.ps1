$ErrorActionPreference = 'Stop'

# Paths and argv arrive as data. The helper never invokes a command shell.
try {
  [int]$parentId = 0
  if (-not [int]::TryParse($env:ELYSIA_CHAT_PARENT_PID, [ref]$parentId) -or $parentId -le 0) { throw 'parent' }
  $server = $env:ELYSIA_CHAT_SERVER
  if ([string]::IsNullOrWhiteSpace($server) -or -not [IO.Path]::IsPathRooted($server) -or -not [IO.File]::Exists($server)) { throw 'server' }
  $server = [IO.Path]::GetFullPath($server)
  $json = $env:ELYSIA_CHAT_ARGS
  if ([string]::IsNullOrWhiteSpace($json) -or $json.Length -gt 65536 -or -not $json.TrimStart().StartsWith('[')) { throw 'arguments' }
  # Windows PowerShell 5 returns the JSON array as one pipeline object; wrapping
  # that pipeline in @() would create a nested array and reject every argument.
  $arguments = ConvertFrom-Json -InputObject $json
  foreach ($argument in $arguments) { if ($argument -isnot [string] -or $argument.Contains([char]0)) { throw 'arguments' } }

  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ElysiaChatRuntimeHost {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint WAIT_TIMEOUT = 258;
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public uint cb;
    public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public uint dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment,
    string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  // Quote for the Windows argv parser, not PowerShell/cmd. Double backslashes
  // before quotes and the closing quote, including empty and trailing-slash args.
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }

  public static int Run(int parentId, string executable, string[] args) {
    using (Process parent = Process.GetProcessById(parentId))
    using (Process self = Process.GetCurrentProcess()) {
      // Keep the original process handle open: PID reuse cannot change the
      // parent we watch. Reject a PID reused after this helper was created.
      IntPtr parentHandle = parent.Handle;
      if (parent.HasExited || parent.StartTime.ToUniversalTime() > self.StartTime.ToUniversalTime()) return 1;
      IntPtr job = CreateJobObject(IntPtr.Zero, null); // NULL attributes: never inherited.
      if (job == IntPtr.Zero) throw new Win32Exception();
      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      var process = new PROCESS_INFORMATION();
      try {
        if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) throw new Win32Exception();
        var command = new StringBuilder(Quote(executable));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        if (command.Length >= 32767) throw new ArgumentException("arguments");
        var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(startup);
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out process)) throw new Win32Exception();
        // Assign while suspended; no model thread or descendant can escape the job.
        if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception();
        if (parent.HasExited) return 0;
        if (ResumeThread(process.hThread) == UInt32.MaxValue) throw new Win32Exception();
        CloseHandle(process.hThread); process.hThread = IntPtr.Zero;
        Console.WriteLine("{\"type\":\"started\",\"pid\":" + process.dwProcessId + "}");
        Console.Out.Flush();
        while (WaitForSingleObject(process.hProcess, 250) == WAIT_TIMEOUT) {
          if (WaitForSingleObject(parentHandle, 0) != WAIT_TIMEOUT) return 0;
        }
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) return 1;
        return unchecked((int)exitCode);
      } finally {
        // Closing this noninherited job also works if the wrapper is forcibly
        // terminated. Explicit termination here covers normal parent shutdown.
        TerminateJobObject(job, 1);
        if (process.hProcess != IntPtr.Zero) {
          // Also cover CreateProcess succeeding but job assignment failing.
          if (WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) TerminateProcess(process.hProcess, 1);
          WaitForSingleObject(process.hProcess, 5000); CloseHandle(process.hProcess);
        }
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        CloseHandle(job);
      }
    }
  }
}
'@
  # Child processes do not need the helper's control data in their environment.
  foreach ($name in @('ELYSIA_CHAT_SERVER', 'ELYSIA_CHAT_ARGS', 'ELYSIA_CHAT_PARENT_PID')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  exit [ElysiaChatRuntimeHost]::Run($parentId, $server, [string[]]$arguments)
} catch {
  [Console]::Error.WriteLine('Local chat runtime host could not start or monitor its process.')
  exit 1
}
