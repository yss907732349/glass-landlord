using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

// One configured chord only. No key names or key events leave this process.
internal static class HideShortcutHelper
{
    private const int WhKeyboardLl = 13, WmKeyDown = 0x100, WmKeyUp = 0x101, WmSysKeyDown = 0x104, WmSysKeyUp = 0x105, WmQuit = 0x12;
    private static readonly HookProc Callback = OnKeyboard;
    private static IntPtr hook;
    private static uint thread;
    private static int target, modifiers;
    private static bool held;
    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardData { public uint vkCode, scanCode, flags, time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; public uint privateData; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);

    private static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    private static int CurrentModifiers()
    {
        return (Down(0x11) ? 1 : 0) | (Down(0x12) ? 2 : 0) | (Down(0x10) ? 4 : 0) | ((Down(0x5b) || Down(0x5c)) ? 8 : 0);
    }
    private static bool Matches(int virtualKey, int activeModifiers) { return virtualKey == target && activeModifiers == modifiers; }
    private static bool Consume(int virtualKey, int kind, int activeModifiers, out bool trigger)
    {
        trigger = false;
        if (virtualKey != target) return false;
        if ((kind == WmKeyUp || kind == WmSysKeyUp) && held) { held = false; return true; }
        if (kind != WmKeyDown && kind != WmSysKeyDown) return false;
        if (held) return true;
        if (!Matches(virtualKey, activeModifiers)) return false;
        held = true; trigger = true; return true;
    }
    private static IntPtr OnKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            KeyboardData key = (KeyboardData)Marshal.PtrToStructure(data, typeof(KeyboardData));
            if (key.vkCode == target)
            {
                bool trigger;
                if (Consume((int)key.vkCode, message.ToInt32(), CurrentModifiers(), out trigger))
                {
                    if (trigger) { Console.WriteLine("TRIGGER"); Console.Out.Flush(); }
                    return new IntPtr(1); // Stop this chord before competing RegisterHotKey handlers.
                }
            }
        }
        return CallNextHookEx(hook, code, message, data);
    }
    private static void Stop() { PostThreadMessage(thread, WmQuit, UIntPtr.Zero, IntPtr.Zero); }
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                target = 0x48; modifiers = 5;
                bool fired;
                if (Consume(0x49, WmKeyDown, 5, out fired) || fired) throw new Exception("Other key was captured");
                if (Consume(0x48, WmKeyDown, 1, out fired) || fired) throw new Exception("Missing modifier was captured");
                if (Consume(0x48, WmKeyDown, 13, out fired) || fired) throw new Exception("Extra Windows modifier was captured");
                if (!Consume(0x48, WmKeyDown, 5, out fired) || !fired) throw new Exception("Chord did not trigger");
                if (!Consume(0x48, WmKeyDown, 5, out fired) || fired) throw new Exception("Auto-repeat toggled again");
                if (Consume(0x49, WmKeyDown, 5, out fired) || fired) throw new Exception("Held chord captured another key");
                if (!Consume(0x48, WmKeyUp, 0, out fired) || fired || held) throw new Exception("Release did not clear held chord");
                if (Consume(0x48, WmKeyUp, 0, out fired)) throw new Exception("Unrelated release was captured");
                if (!Consume(0x48, WmSysKeyDown, 5, out fired) || !fired) throw new Exception("Next press failed");
                Console.WriteLine("SELFTEST OK"); return 0;
            }
            if (args.Length != 2 || !Int32.TryParse(args[0], out target) || !Int32.TryParse(args[1], out modifiers) || target < 0x20 || target > 0x87 || modifiers < 1 || modifiers > 7) throw new Exception("Invalid chord");
            thread = GetCurrentThreadId();
            Message unused; PeekMessage(out unused, IntPtr.Zero, 0, 0, 0);
            hook = SetWindowsHookEx(WhKeyboardLl, Callback, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            // Pipe EOF also releases the hook if the Electron parent is killed.
            Thread input = new Thread(delegate() { try { while (Console.ReadLine() != null) { } } finally { Stop(); } });
            input.IsBackground = true; input.Start();
            Console.WriteLine("READY"); Console.Out.Flush();
            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
            return 0;
        }
        catch (Exception error) { Console.WriteLine("ERROR " + error.GetType().Name); Console.Out.Flush(); return 1; }
        finally { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
    }
}
