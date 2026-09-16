using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class WindowsTray : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly ContextMenuStrip menu = new ContextMenuStrip();
    private readonly Control dispatch = new Control();
    private readonly ToolStripMenuItem status = new ToolStripMenuItem("Happy Agent is running");
    private readonly ToolStripMenuItem resources = new ToolStripMenuItem("Reading resource usage...");
    private readonly ToolStripMenuItem usage = new ToolStripMenuItem("Plan and token usage");
    private readonly ToolStripMenuItem stop = new ToolStripMenuItem("Stop Happy Agent");
    private readonly ToolStripMenuItem force = new ToolStripMenuItem("Force stop Happy Agent");
    private readonly Timer refreshTimer = new Timer { Interval = 5000 };
    private readonly Timer forceTimer = new Timer { Interval = 5000 };
    private readonly Process parent;
    private readonly DaemonClient client;
    private bool refreshing;
    private bool closed;
    private bool stopping;
    private DateTime sampledAt = DateTime.UtcNow;
    private TimeSpan sampledCpu;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (!Environment.UserInteractive) return 0;
            var options = new Dictionary<string, string>();
            for (int i = 0; i + 1 < args.Length; i += 2) options.Add(args[i], args[i + 1]);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var parent = Process.GetProcessById(int.Parse(options["--parent-pid"])))
            using (var tray = new WindowsTray(parent, new DaemonClient(options["--socket"], options["--token-file"])))
                Application.Run(tray);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Happy tray: " + error.Message);
            return 1;
        }
    }

    private WindowsTray(Process parent, DaemonClient client)
    {
        this.parent = parent;
        this.client = client;
        sampledCpu = parent.TotalProcessorTime;
        // A hidden control owns dispatch to the UI thread; there is no application window.
        dispatch.CreateControl();
        status.Enabled = false;
        resources.Enabled = false;
        force.Visible = false;
        menu.Items.AddRange(new ToolStripItem[] { status, resources, usage, new ToolStripSeparator(), stop, force });
        icon = new NotifyIcon { Icon = CreateIcon(), Text = "Happy Agent is running", ContextMenuStrip = menu, Visible = true };
        menu.Opening += delegate { Refresh(); refreshTimer.Start(); };
        menu.Closed += delegate { refreshTimer.Stop(); };
        refreshTimer.Tick += delegate { Refresh(); };
        stop.Click += async delegate { await Stop(); };
        force.Click += async delegate { await ForceStop(); };
        forceTimer.Tick += delegate { forceTimer.Stop(); if (!closed) force.Visible = true; };
        parent.EnableRaisingEvents = true;
        parent.Exited += delegate { OnUi(ExitThread); };
        if (parent.HasExited) { ExitThread(); return; }
        // EOF also handles normal module disposal. Neither mechanism polls the process table.
        Task.Run(delegate {
            using (Stream input = Console.OpenStandardInput())
                while (input.ReadByte() != -1) { }
            OnUi(ExitThread);
        });
    }

    private async void Refresh()
    {
        if (closed || refreshing) return;
        refreshing = true;
        try
        {
            parent.Refresh();
            DateTime now = DateTime.UtcNow;
            TimeSpan cpu = parent.TotalProcessorTime;
            double elapsed = (now - sampledAt).TotalSeconds;
            double percent = elapsed <= 0 ? 0 : (cpu - sampledCpu).TotalSeconds / elapsed / Environment.ProcessorCount * 100;
            resources.Text = string.Format(CultureInfo.CurrentCulture, "CPU {0:0.0}% average | Memory {1:N0} MB", percent, parent.WorkingSet64 / 1048576.0);
            sampledCpu = cpu;
            sampledAt = now;
            DaemonUsage snapshot = await Task.Run(() => client.Usage());
            if (closed) return;
            usage.DropDownItems.Clear();
            foreach (UsageProvider provider in snapshot.Providers ?? new UsageProvider[0])
            {
                if (!provider.Enabled) continue;
                string name = CultureInfo.CurrentCulture.TextInfo.ToTitleCase((provider.Id ?? "Provider").Replace('_', ' ').Replace('-', ' ').Replace('.', ' '));
                if (provider.Usage == null || provider.Usage.Windows == null)
                {
                    AddUsage(name + ": usage unavailable");
                    continue;
                }
                UsageWindows windows = provider.Usage.Windows;
                AddWindow(name + " session", windows.Session);
                AddWindow(name + " week", windows.Week);
                AddWindow(name + " Fable week", windows.Fable);
                if (windows.Session == null) AddWindow(name + " month", windows.Month);
            }
            long input = 0, output = 0;
            if (snapshot.Day != null)
                foreach (var provider in snapshot.Day.Values)
                    foreach (var tokens in provider.Values) { input += tokens.Input; output += tokens.Output; }
            AddUsage(string.Format(CultureInfo.CurrentCulture, "Last 24 hours: {0:N0} input / {1:N0} output tokens", input, output));
            if (!stopping) status.Text = "Happy Agent is running";
        }
        catch (Exception)
        {
            if (!closed) status.Text = stopping ? "Stopping Happy Agent..." : "Happy Agent is not responding";
        }
        finally { refreshing = false; }
    }

    private void AddWindow(string label, UsageWindow window)
    {
        if (window == null) return;
        string reset = window.ResetsAt.HasValue
            ? " | resets " + new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero).AddMilliseconds(window.ResetsAt.Value).LocalDateTime.ToString("g") : "";
        AddUsage(string.Format(CultureInfo.CurrentCulture, "{0}: {1:0}% used{2}", label, window.UsedPercent, reset));
    }

    private void AddUsage(string text) { usage.DropDownItems.Add(new ToolStripMenuItem(text) { Enabled = false }); }

    private async Task Stop()
    {
        if (stopping || closed) return;
        stopping = true;
        stop.Enabled = false;
        status.Text = "Stopping Happy Agent...";
        icon.Text = "Stopping Happy Agent";
        forceTimer.Start();
        try { await Task.Run(() => client.Stop()); }
        catch (Exception)
        {
            if (!closed) { status.Text = "Happy Agent could not stop gracefully"; force.Visible = true; }
        }
    }

    private async Task ForceStop()
    {
        try
        {
            // The retained Process handle identifies our parent. Never read an unrelated PID file.
            if (parent.HasExited) { ExitThread(); return; }
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "taskkill.exe"),
                "/PID " + parent.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true };
            force.Enabled = false;
            icon.Visible = false;
            await Task.Run(delegate {
                using (var killer = Process.Start(start))
                    if (killer == null || !killer.WaitForExit(5000) || killer.ExitCode != 0)
                        throw new IOException("Windows could not terminate the daemon process tree.");
            });
        }
        catch (Exception)
        {
            if (!closed) {
                icon.Visible = true;
                force.Enabled = true;
                status.Text = "Windows could not stop Happy Agent";
            }
        }
    }

    private void OnUi(Action action)
    {
        if (closed || dispatch.IsDisposed) return;
        try { dispatch.BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    protected override void ExitThreadCore()
    {
        if (closed) return;
        closed = true;
        refreshTimer.Dispose();
        forceTimer.Dispose();
        icon.Visible = false;
        icon.Icon.Dispose();
        icon.Dispose();
        menu.Dispose();
        dispatch.Dispose();
        base.ExitThreadCore();
    }

    private static Icon CreateIcon()
    {
        // The same stationary star as the macOS status item, drawn once with no animation timer.
        using (var bitmap = new Bitmap(32, 32))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var points = new PointF[10];
            for (int i = 0; i < points.Length; i++)
            {
                double angle = -Math.PI / 2 + i * Math.PI / 5;
                double radius = i % 2 == 0 ? 14 : 6;
                points[i] = new PointF((float)(16 + radius * Math.Cos(angle)), (float)(16 + radius * Math.Sin(angle)));
            }
            graphics.FillPolygon(Brushes.Gold, points);
            IntPtr handle = bitmap.GetHicon();
            try { using (var borrowed = Icon.FromHandle(handle)) return (Icon)borrowed.Clone(); }
            finally { DestroyIcon(handle); }
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);
}
