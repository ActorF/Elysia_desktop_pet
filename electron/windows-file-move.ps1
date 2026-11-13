$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Fixed native code: caller paths and identity values are environment data.
# Rename the guarded source handle, never copy bytes or replace a destination.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ElysiaVerifiedFileMove {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes;
    public FileTime Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr info, uint bytes);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  static string Value(string name) { return Environment.GetEnvironmentVariable("ELYSIA_MOVE_" + name); }
  static ulong Number(string name) { return UInt64.Parse(Value(name), NumberStyles.None, CultureInfo.InvariantCulture); }
  static ulong Join(uint high, uint low) { return ((ulong)high << 32) | low; }
  static bool Identity(FileInfo info, string prefix) {
    return info.Volume == Number(prefix + "DEV") && Join(info.IndexHigh, info.IndexLow) == Number(prefix + "INO");
  }
  public static int Run() {
    string source = Value("SOURCE"), destination = Value("DESTINATION"), parent = Value("PARENT"), name = Value("NAME");
    if (String.IsNullOrEmpty(source) || String.IsNullOrEmpty(destination) || String.IsNullOrEmpty(parent)
        || String.IsNullOrEmpty(name) || name.IndexOfAny(new char[] {'\\', '/', ':', '\0'}) >= 0) return 87;
    // Parent and source cannot be replaced while these noninherited handles
    // are open. The source also denies concurrent writes during publication.
    using (SafeFileHandle directory = CreateFileW(parent, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (directory.IsInvalid) return Marshal.GetLastWin32Error();
      FileInfo parentInfo;
      if (!GetFileInformationByHandle(directory, out parentInfo)) return Marshal.GetLastWin32Error();
      if ((parentInfo.Attributes & 0x10) == 0 || (parentInfo.Attributes & 0x400) != 0 || !Identity(parentInfo, "PARENT_")) return 32;
      if (parentInfo.Volume != Number("DEV")) return 17;
      // Resolve the held directory to its volume GUID spelling, so an ancestor
      // junction cannot redirect the final destination after validation.
      StringBuilder finalParent = new StringBuilder(32768);
      uint parentLength = GetFinalPathNameByHandleW(directory, finalParent, (uint)finalParent.Capacity, 1);
      if (parentLength == 0) return Marshal.GetLastWin32Error();
      if (parentLength >= finalParent.Capacity) return 206;
      destination = finalParent.ToString().TrimEnd('\\') + "\\" + name;
      using (SafeFileHandle file = CreateFileW(source, 0x00010080, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        if (file.IsInvalid) return Marshal.GetLastWin32Error();
        FileInfo info;
        if (!GetFileInformationByHandle(file, out info)) return Marshal.GetLastWin32Error();
        long modified = checked(((long)Join(info.Write.High, info.Write.Low) - 116444736000000000L) * 100);
        if ((info.Attributes & 0x410) != 0 || !Identity(info, "") || Join(info.SizeHigh, info.SizeLow) != Number("SIZE")
            || modified != Int64.Parse(Value("MTIME"), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture)) return 32;
        byte[] filename = Encoding.Unicode.GetBytes(destination);
        int rootOffset = IntPtr.Size == 8 ? 8 : 4, lengthOffset = rootOffset + IntPtr.Size, nameOffset = lengthOffset + 4;
        int length = nameOffset + filename.Length + 2;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try {
          // Zero includes ReplaceIfExists=false, all padding and a terminal NUL.
          Marshal.Copy(new byte[length], 0, buffer, length);
          Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
          Marshal.WriteInt32(buffer, lengthOffset, filename.Length);
          Marshal.Copy(filename, 0, IntPtr.Add(buffer, nameOffset), filename.Length);
          return SetFileInformationByHandle(file, 3, buffer, (uint)length) ? 0 : Marshal.GetLastWin32Error();
        } finally { Marshal.FreeHGlobal(buffer); }
      }
    }
  }
}
'@
  exit [ElysiaVerifiedFileMove]::Run()
} catch {
  # Compilation/policy/unexpected wrapper failures are not path diagnostics.
  exit 79
}
