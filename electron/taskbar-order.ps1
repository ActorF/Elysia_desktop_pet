param(
  [Parameter(Mandatory = $true)][string]$TargetHwnd,
  [Parameter(Mandatory = $true)][int]$ParentProcessId
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ElysiaTaskbarOrder {
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr parent);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr BeginDeferWindowPos(int count);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr DeferWindowPos(IntPtr batch, IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EndDeferWindowPos(IntPtr batch);

    private static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    private static long nextRepair;
    private const uint PositionFlags = 0x0001 | 0x0002 | 0x0010 | 0x0200; // NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER

    private static bool Visible(IntPtr hwnd) {
        int cloaked;
        return IsWindowVisible(hwnd) && !IsIconic(hwnd) &&
            (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) != 0 || cloaked == 0);
    }
    private static string ClassName(IntPtr hwnd) {
        StringBuilder name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }
    private static bool Taskbar(IntPtr hwnd, uint shellProcessId) {
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        if (shellProcessId == 0 || processId != shellProcessId || !Visible(hwnd) || !Topmost(hwnd)) return false;
        string name = ClassName(hwnd);
        if (name != "Shell_TrayWnd" && name != "Shell_SecondaryTrayWnd") return false;
        Rect rect;
        // Do not restore hidden, cloaked, off-screen or fullscreen-demoted bars.
        return GetWindowRect(hwnd, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top &&
            MonitorFromRect(ref rect, 0) != IntPtr.Zero;
    }

    private static bool Owned(IntPtr hwnd, uint parentProcessId) {
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        return IsWindow(hwnd) && processId == parentProcessId;
    }
    private static bool Topmost(IntPtr hwnd) {
        long style = IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20);
        return (style & 8) != 0;
    }
    public static bool Tick(IntPtr own, uint parentProcessId) {
        if (!Owned(own, parentProcessId)) return false;
        if (!Visible(own)) return true;
        uint shellProcessId;
        GetWindowThreadProcessId(GetShellWindow(), out shellProcessId);
        IntPtr cursor = GetTopWindow(IntPtr.Zero);
        int rank = 0, ownRank = -1, taskbarRank = -1;
        HashSet<IntPtr> seen = new HashSet<IntPtr>();
        List<IntPtr> taskbars = new List<IntPtr>();
        List<int> applicationRanks = new List<int>();
        List<KeyValuePair<IntPtr, int>> companions = new List<KeyValuePair<IntPtr, int>>();
        while (cursor != IntPtr.Zero && rank < 20000 && seen.Add(cursor)) {
            if (cursor == own) ownRank = rank;
            if (Taskbar(cursor, shellProcessId)) {
                taskbars.Add(cursor); taskbarRank = rank;
            } else if (Visible(cursor)) {
                uint processId;
                GetWindowThreadProcessId(cursor, out processId);
                // Our subtitles/trail belong above the pet and must not trigger
                // a never-ending fight between windows of the same application.
                if (processId != parentProcessId) applicationRanks.Add(rank);
                else if (cursor != own && Topmost(cursor)) companions.Add(new KeyValuePair<IntPtr, int>(cursor, rank));
            }
            cursor = GetWindow(cursor, 2); rank++; // GW_HWNDNEXT, top to bottom.
        }
        if (cursor != IntPtr.Zero || ownRank < 0) return true;
        bool applicationAbove = false;
        foreach (int applicationRank in applicationRanks) {
            if (applicationRank < ownRank) { applicationAbove = true; break; }
        }
        // WS_EX_TOPMOST alone is insufficient: Explorer can leave a secondary
        // taskbar below ordinary application windows while retaining that bit.
        // Inserting the pet behind that bar also buries the pet behind apps.
        if (Topmost(own) && ownRank > taskbarRank && !applicationAbove) return true;
        if (clock.ElapsedMilliseconds < nextRepair) return true;
        nextRepair = clock.ElapsedMilliseconds + 500;
        if (!Owned(own, parentProcessId) || !Visible(own)) return true;
        IntPtr parent = GetAncestor(own, 1); // GA_PARENT, not the popup owner.
        foreach (IntPtr taskbar in taskbars)
            if (!Taskbar(taskbar, shellProcessId) || GetAncestor(taskbar, 1) != parent) return true;
        List<IntPtr> overlays = new List<IntPtr>();
        foreach (KeyValuePair<IntPtr, int> companion in companions)
            if (companion.Value < ownRank && Owned(companion.Key, parentProcessId) &&
                Visible(companion.Key) && Topmost(companion.Key) && GetAncestor(companion.Key, 1) == parent)
                overlays.Add(companion.Key);

        // Restore the complete ordering in one batch: visible shell taskbars,
        // our pet, other applications. Preserve taskbar order, bounds, visibility
        // and native topmost flags; never activate or show any window.
        // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-deferwindowpos
        // If no taskbar is available, the same batch still restores ordinary
        // topmost. Keep existing speech/trail overlays above their own pet.
        IntPtr batch = BeginDeferWindowPos(taskbars.Count + overlays.Count + 1);
        if (batch == IntPtr.Zero) return true;
        IntPtr after = new IntPtr(-1); // HWND_TOPMOST
        foreach (IntPtr taskbar in taskbars) {
            batch = DeferWindowPos(batch, taskbar, after, 0, 0, 0, 0, PositionFlags);
            if (batch == IntPtr.Zero) return true; // A failed batch must not be committed.
            after = taskbar;
        }
        foreach (IntPtr overlay in overlays) {
            batch = DeferWindowPos(batch, overlay, after, 0, 0, 0, 0, PositionFlags);
            if (batch == IntPtr.Zero) return true;
            after = overlay;
        }
        batch = DeferWindowPos(batch, own, after, 0, 0, 0, 0, PositionFlags);
        if (batch != IntPtr.Zero) EndDeferWindowPos(batch);
        return true;
    }
}
'@

$taskbarWindow = [IntPtr]::new([Convert]::ToInt64($TargetHwnd.Replace('0x', ''), 16))
$taskbarParent = [System.Diagnostics.Process]::GetProcessById($ParentProcessId)
try {
  if (-not [ElysiaTaskbarOrder]::Tick($taskbarWindow, $ParentProcessId)) { exit 1 }
  [Console]::WriteLine('READY')
  while (-not $taskbarParent.HasExited) {
    Start-Sleep -Milliseconds 100
    if (-not [ElysiaTaskbarOrder]::Tick($taskbarWindow, $ParentProcessId)) { break }
  }
} finally { $taskbarParent.Dispose() }
