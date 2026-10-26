param(
  [Parameter(Mandatory = $true)][string]$TargetHwnd,
  [Parameter(Mandatory = $true)][int]$OwnerProcessId
)

# Read-only Win32 inspection. The target belongs to the requesting Electron
# process; a peer must match its explicitly supplied test process ID. No window
# APIs mutate focus, visibility, position, or z-order here.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ElysiaTaskbarOrderProbe {
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr parent);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rectangle);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr hwnd, int index);

    [StructLayout(LayoutKind.Sequential)] public struct Rect {
        public int left, top, right, bottom;
    }
    public sealed class WindowInfo {
        public string hwnd;
        public string className;
        public uint processId;
        public int rank;
        public bool visible;
        public bool topmost;
        public Rect bounds;
    }
    public sealed class Snapshot {
        public WindowInfo target;
        public WindowInfo peer;
        public WindowInfo foreground;
        public WindowInfo[] taskbars;
        public int enumerated;
        public bool chainComplete;
    }
    private static WindowInfo Describe(IntPtr hwnd, int rank) {
        StringBuilder name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        Rect bounds;
        GetWindowRect(hwnd, out bounds);
        long style = IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20);
        return new WindowInfo {
            hwnd = "0x" + hwnd.ToInt64().ToString("X"), className = name.ToString(),
            processId = processId, rank = rank, visible = IsWindowVisible(hwnd),
            topmost = (style & 8) != 0, bounds = bounds
        };
    }
    public static Snapshot Read(string targetHex, int expectedProcessId, string peerHex, int expectedPeerProcessId) {
        IntPtr target = new IntPtr(Convert.ToInt64(targetHex.Replace("0x", ""), 16));
        uint processId;
        GetWindowThreadProcessId(target, out processId);
        if (!IsWindow(target) || processId != (uint)expectedProcessId)
            throw new InvalidOperationException("The test HWND is not owned by the expected Electron process.");
        IntPtr peer = String.IsNullOrEmpty(peerHex) ? IntPtr.Zero : new IntPtr(Convert.ToInt64(peerHex.Replace("0x", ""), 16));
        if (peer != IntPtr.Zero) {
            GetWindowThreadProcessId(peer, out processId);
            if (expectedPeerProcessId <= 0 || !IsWindow(peer) || processId != (uint)expectedPeerProcessId)
                throw new InvalidOperationException("The peer HWND is not owned by its explicitly supplied test process.");
        }
        List<WindowInfo> taskbars = new List<WindowInfo>();
        HashSet<IntPtr> seen = new HashSet<IntPtr>();
        WindowInfo targetInfo = null;
        WindowInfo peerInfo = null;
        IntPtr foreground = GetForegroundWindow();
        WindowInfo foregroundInfo = Describe(foreground, -1);
        IntPtr cursor = GetTopWindow(IntPtr.Zero);
        int rank = 0;
        // A bounded walk is important: windows may disappear during inspection.
        while (cursor != IntPtr.Zero && rank < 20000 && seen.Add(cursor)) {
            WindowInfo info = Describe(cursor, rank);
            if (cursor == target) targetInfo = info;
            if (cursor == peer) peerInfo = info;
            if (cursor == foreground) foregroundInfo.rank = rank;
            if (info.className == "Shell_TrayWnd" || info.className == "Shell_SecondaryTrayWnd")
                taskbars.Add(info);
            cursor = GetWindow(cursor, 2); // GW_HWNDNEXT, top to bottom.
            rank++;
        }
        return new Snapshot {
            target = targetInfo, peer = peerInfo, foreground = foregroundInfo, taskbars = taskbars.ToArray(),
            enumerated = rank, chainComplete = cursor == IntPtr.Zero
        };
    }
}
'@

[Console]::WriteLine('{"ready":true}')
while ($null -ne ($probeLine = [Console]::ReadLine())) {
  try {
    $probeRequest = $probeLine | ConvertFrom-Json
    if ($probeRequest.action -eq 'helpers') {
      $probeSnapshot = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $OwnerProcessId" |
        Where-Object { $_.CommandLine -match '(?i)[\\/]taskbar-order\.ps1(?:"|\s)' } |
        Select-Object ProcessId, ParentProcessId)
    } else {
      $probeSnapshot = [ElysiaTaskbarOrderProbe]::Read($TargetHwnd, $OwnerProcessId, $probeRequest.peerHwnd, [int]$probeRequest.peerProcessId)
    }
    [Console]::WriteLine((@{ sequence = $probeRequest.sequence; snapshot = $probeSnapshot } | ConvertTo-Json -Depth 8 -Compress))
  } catch {
    [Console]::WriteLine((@{ sequence = $probeRequest.sequence; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
