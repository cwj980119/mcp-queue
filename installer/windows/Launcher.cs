using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// The launcher owns only its bundled Node process and children. No global Node/agent process is stopped.
internal static class Program
{
    internal const string MutexName = @"Local\McpQueueDesktop";
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        int port;
        if (!Int32.TryParse(Environment.GetEnvironmentVariable("QUEUE_CLIENT_PORT") ?? "3210", out port) || port < 1024 || port > 65535)
        {
            Failure("QUEUE_CLIENT_PORT 설정을 확인하세요."); return;
        }
        string url = "http://127.0.0.1:" + port;
        bool created;
        using (var mutex = new Mutex(true, MutexName, out created))
        {
            if (!created) { Open(url); return; }
            try { using (var app = new DesktopApp(url)) Application.Run(app); }
            catch { Failure("앱을 시작하지 못했습니다. 다른 MCP Queue 창을 종료하거나 앱을 다시 설치하세요."); }
            finally { mutex.ReleaseMutex(); }
        }
    }
    internal static void Open(string url)
    {
        if (Environment.GetEnvironmentVariable("QUEUE_NO_OPEN_BROWSER") == "1") return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { MessageBox.Show("브라우저에서 " + url + " 을 여세요.", "MCP Queue"); }
    }
    internal static void Failure(string message)
    {
        Environment.ExitCode = 1;
        if (Environment.GetEnvironmentVariable("QUEUE_DESKTOP_TEST") != "1") MessageBox.Show(message, "MCP Queue");
    }
}

internal sealed class DesktopApp : ApplicationContext
{
    private readonly Process child;
    private readonly ChildJob job;
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer ready;
    private readonly string url;
    private int attempts;
    private bool closing;

    internal DesktopApp(string address)
    {
        url = address;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        job = new ChildJob();
        child = new Process();
        child.StartInfo = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "\"" + Path.Combine(root, "dist", "src", "client.js") + "\"")
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        child.StartInfo.EnvironmentVariables["QUEUE_NO_OPEN_BROWSER"] = "1";
        child.StartInfo.EnvironmentVariables["QUEUE_DESKTOP_HOST"] = "1";
        // Drain output without persisting tasks, provider details or credentials to a desktop log.
        child.OutputDataReceived += delegate { };
        child.ErrorDataReceived += delegate { };
        try
        {
            child.Start(); job.Attach(child);
            child.BeginOutputReadLine(); child.BeginErrorReadLine();
        }
        catch
        {
            try { if (!child.HasExited) child.Kill(); } catch { }
            child.Dispose(); job.Dispose(); throw;
        }
        var menu = new ContextMenuStrip();
        menu.Items.Add("PC 연결 화면 열기", null, delegate { Program.Open(url); });
        menu.Items.Add("종료", null, delegate { ExitThread(); });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "MCP Queue · 시작 중", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { Program.Open(url); };
        ready = new System.Windows.Forms.Timer { Interval = 500 };
        ready.Tick += CheckReady;
        ready.Start();
    }
    private void CheckReady(object sender, EventArgs args)
    {
        if (closing) return;
        if (child.HasExited || ++attempts > 40)
        {
            ready.Stop();
            Program.Failure("PC 연결 프로그램이 시작되지 않았습니다. 해당 포트를 사용하는 기존 프로그램을 확인하고 다시 실행하세요.");
            ExitThread(); return;
        }
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(url + "/client-info");
            request.Proxy = null; request.Timeout = 500; request.AllowAutoRedirect = false;
            using (var response = request.GetResponse())
            using (var stream = new StreamReader(response.GetResponseStream()))
            {
                var info = new JavaScriptSerializer().Deserialize<Info>(stream.ReadToEnd());
                if (info.name != "mcp-queue-client" || info.pid != child.Id) return;
            }
            ready.Stop(); tray.Text = "MCP Queue · 실행 중"; Program.Open(url);
            // Continue monitoring the owned process after startup too.
            ready.Tick -= CheckReady; ready.Tick += delegate { if (!closing && child.HasExited) { Program.Failure("MCP Queue가 종료되었습니다. 아이콘을 눌러 다시 실행하세요."); ExitThread(); } };
            ready.Interval = 2000; ready.Start();
        }
        catch (WebException) { }
        catch (InvalidOperationException) { }
    }
    protected override void ExitThreadCore()
    {
        if (closing) return;
        closing = true; ready.Stop(); tray.Text = "MCP Queue · 종료 중";
        try
        {
            if (!child.HasExited) { child.StandardInput.WriteLine("quit"); child.StandardInput.Flush(); child.WaitForExit(15000); }
        }
        catch { }
        finally
        {
            // If graceful shutdown stalls, closing this job terminates only our process tree.
            job.Dispose(); child.Dispose(); tray.Visible = false; tray.Dispose(); ready.Dispose();
            base.ExitThreadCore();
        }
    }
    private sealed class Info { public string name { get; set; } public int pid { get; set; } }
}

internal sealed class ChildJob : IDisposable
{
    private IntPtr handle;
    internal ChildJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var limits = new ExtendedLimit(); limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) { Dispose(); throw new System.ComponentModel.Win32Exception(); }
    }
    internal void Attach(Process process) { if (!AssignProcessToJobObject(handle, process.Handle)) throw new System.ComponentModel.Win32Exception(); }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimit { public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
