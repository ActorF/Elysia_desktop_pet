param([int]$ParentProcessId)
$ErrorActionPreference = 'Stop'
# Reports only a boolean interruption state. No titles, text or input contents.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VoiceEnvironment {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Init() { SetProcessDPIAware(); }
  public static bool Blocked(int parent) {
    int state;
    if (SHQueryUserNotificationState(out state) >= 0 && (state == 1 || state == 2 || state == 3 || state == 4 || state == 6)) return true;
    IntPtr window = GetForegroundWindow();
    if (window == IntPtr.Zero || window == GetShellWindow() || window == GetDesktopWindow()) return false;
    uint process; GetWindowThreadProcessId(window, out process);
    if (process == (uint)parent) return false;
    Rect bounds; var info = new MonitorInfo(); info.Size = Marshal.SizeOf(info);
    if (!GetWindowRect(window, out bounds) || !GetMonitorInfo(MonitorFromWindow(window, 2), ref info)) return false;
    return bounds.Left <= info.Monitor.Left && bounds.Top <= info.Monitor.Top && bounds.Right >= info.Monitor.Right && bounds.Bottom >= info.Monitor.Bottom;
  }
}
'@
[VoiceEnvironment]::Init()
while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
  if ([VoiceEnvironment]::Blocked($ParentProcessId)) { [Console]::WriteLine('BLOCKED') } else { [Console]::WriteLine('CLEAR') }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
