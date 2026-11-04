using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

// The Windows notification-area app. Its menu matches the macOS one where Windows allows it: a
// headline, plan usage per account, then the few top-level tasks and bots working most recently,
// with a single Quit Happy action below the headline. C# 5 and ASCII only; see
// DaemonClient.cs.
internal sealed class WindowsTray : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly ContextMenuStrip menu = new ContextMenuStrip();
    private readonly Control dispatch = new Control();
    private readonly ToolStripMenuItem status = new ToolStripMenuItem("Happy Agent is running");
    private readonly ToolStripMenuItem resources = new ToolStripMenuItem("Reading resource usage...");
    private readonly ToolStripSeparator controlsSeparator = new ToolStripSeparator();
    private readonly ToolStripMenuItem quit = new ToolStripMenuItem("Quit Happy");
    private readonly Timer refreshTimer = new Timer { Interval = 5000 };
    // Only while the menu is open: the session times tick the way the desktop's clock does.
    private readonly Timer clockTimer = new Timer { Interval = 1000 };
    private readonly Process parent;
    private readonly DaemonClient client;
    private readonly PlanBook planBook = new PlanBook();
    private readonly Font headerFont;
    // Read and written only inside a refresh's background work, which never overlaps another.
    private readonly Dictionary<string, DateTime> turnStarts = new Dictionary<string, DateTime>();
    private readonly HashSet<string> turnLookups = new HashSet<string>();
    private readonly List<ToolStripItem> rows = new List<ToolStripItem>();
    private readonly List<KeyValuePair<ToolStripMenuItem, DateTime>> clocks = new List<KeyValuePair<ToolStripMenuItem, DateTime>>();
    private List<PlanVendor> vendors = new List<PlanVendor>();
    private bool refreshing;
    private bool refreshAccountsPending;
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
        status.Tag = new RowLook { Text = SystemColors.MenuText };
        resources.Enabled = false;
        headerFont = new Font(menu.Font.FontFamily, menu.Font.Size * 0.85f, FontStyle.Bold);
        menu.Renderer = new TrayRenderer();
        menu.ShowItemToolTips = true;
        menu.Items.AddRange(new ToolStripItem[] { status, new ToolStripSeparator(), quit, controlsSeparator, resources });
        // The icon stays still: the menu reads the daemon only while it is open, so the tray has
        // nothing to animate from the rest of the time, and polling just to animate is not worth it.
        icon = new NotifyIcon { Icon = CreateIcon(), Text = "Happy Agent is running", ContextMenuStrip = menu, Visible = true };
        menu.Opening += delegate
        {
            // A turn may have ended and another begun while the menu was closed, so every working
            // agent's turn start is read again.
            Refresh(true);
            refreshTimer.Start();
            clockTimer.Start();
        };
        menu.Closed += delegate { refreshTimer.Stop(); clockTimer.Stop(); };
        refreshTimer.Tick += delegate { Refresh(); };
        clockTimer.Tick += delegate { Tick(); };
        quit.Click += async delegate { await Quit(); };
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

    private sealed class Reading
    {
        public DaemonUsage Usage;
        public List<WorkEntry> Work;
    }

    private async void Refresh(bool menuOpened = false)
    {
        if (closed) return;
        if (refreshing) { refreshAccountsPending |= menuOpened; return; }
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
            Reading reading = await Task.Run(() => Read(menuOpened));
            if (closed) return;
            if (reading.Usage != null) vendors = planBook.Update(reading.Usage.Providers, DateTime.UtcNow);
            Show(reading.Work, reading.Usage);
        }
        catch (Exception)
        {
            if (!closed)
            {
                status.Text = stopping ? "Quitting Happy..." : "Happy Agent is not responding";
                status.ShortcutKeyDisplayString = null;
            }
        }
        finally
        {
            refreshing = false;
            if (refreshAccountsPending) { refreshAccountsPending = false; Refresh(true); }
        }
    }

    /// <summary>
    /// Everything the menu shows, read off the UI thread. Losing the tasks and bots means the daemon
    /// is not answering; losing only usage keeps the plan rows as they were.
    /// </summary>
    private Reading Read(bool menuOpened)
    {
        var reading = new Reading();
        try { reading.Usage = client.Usage(menuOpened); } catch (Exception) { }
        WorkRow[] tasks;
        WorkRow[] bots;
        try { bots = client.Work(out tasks); }
        catch (Exception) { turnStarts.Clear(); turnLookups.Clear(); throw; }
        reading.Work = WorkReader.Read(bots, tasks);
        if (menuOpened) { turnStarts.Clear(); turnLookups.Clear(); }
        var working = new HashSet<string>();
        foreach (WorkEntry entry in reading.Work)
            if (entry.IsWorking) foreach (string id in entry.WorkingAgentIds) working.Add(id);
        foreach (string id in new List<string>(turnStarts.Keys)) if (!working.Contains(id)) turnStarts.Remove(id);
        turnLookups.IntersectWith(working);
        foreach (string id in working)
        {
            if (turnStarts.ContainsKey(id) || turnLookups.Contains(id)) continue;
            turnLookups.Add(id);
            try
            {
                DateTime? start = PlanBook.FromUnixMs(client.RunningTurnStart(id));
                if (start.HasValue) turnStarts[id] = start.Value;
            }
            catch (Exception) { }
        }
        foreach (WorkEntry entry in reading.Work)
            foreach (string id in entry.WorkingAgentIds)
            {
                DateTime start;
                if (turnStarts.TryGetValue(id, out start)) { entry.Since = start; break; }
            }
        return reading;
    }

    /// <summary>Replaces the rows between the headline and the controls.</summary>
    private void Show(List<WorkEntry> work, DaemonUsage usage)
    {
        DateTime now = DateTime.UtcNow;
        var working = new List<KeyValuePair<int, WorkEntry>>();
        foreach (WorkEntry entry in work) if (entry.IsWorking) working.Add(new KeyValuePair<int, WorkEntry>(working.Count, entry));
        // The most recently started turn first, unknown starts last, otherwise in list order.
        working.Sort((a, b) =>
        {
            DateTime left = a.Value.Since ?? DateTime.MinValue;
            DateTime right = b.Value.Since ?? DateTime.MinValue;
            return left == right ? a.Key.CompareTo(b.Key) : right.CompareTo(left);
        });

        if (!stopping) status.Text = working.Count == 0 ? "All idle" : working.Count.ToString(CultureInfo.CurrentCulture) + " working";
        long tokens = 0;
        if (usage != null && usage.Day != null)
            foreach (var provider in usage.Day.Values)
                foreach (var totals in provider.Values) tokens += totals.Input + totals.Output;
        status.ShortcutKeyDisplayString = tokens > 0 ? TrayText.Tokens(tokens) + " tokens in 24h" : null;

        menu.SuspendLayout();
        foreach (ToolStripItem row in rows)
        {
            menu.Items.Remove(row);
            if (row.Image != null) row.Image.Dispose();
            row.Dispose();
        }
        rows.Clear();
        clocks.Clear();
        var added = new List<ToolStripItem>();
        if (vendors.Count > 0) added.Add(new ToolStripSeparator());
        PlanColumns previous = null;
        foreach (PlanVendor vendor in vendors)
        {
            var layout = new PlanColumns(vendor, menu.Font, headerFont);
            // Column names are repeated only where the columns no longer line up with those above.
            bool labels = previous == null || !layout.SameAs(previous);
            previous = layout;
            added.Add(layout.Header(vendor, labels));
            foreach (PlanEntry entry in vendor.Plans) added.Add(layout.Row(entry, now, menu.ImageScalingSize));
        }
        if (working.Count > 0) added.Add(new ToolStripSeparator());
        for (int i = 0; i < working.Count && i < TrayText.SessionLimit; i++)
        {
            WorkEntry entry = working[i].Value;
            var item = new ToolStripMenuItem(Shorten(entry.Name, 48))
            {
                Enabled = false,
                ToolTipText = entry.Name,
                Tag = new RowLook { Text = SystemColors.MenuText },
            };
            if (entry.Since.HasValue)
            {
                item.ShortcutKeyDisplayString = TrayText.Duration(entry.Since.Value, now);
                clocks.Add(new KeyValuePair<ToolStripMenuItem, DateTime>(item, entry.Since.Value));
            }
            added.Add(item);
        }
        if (working.Count > TrayText.SessionLimit)
            added.Add(new ToolStripMenuItem("+" + (working.Count - TrayText.SessionLimit).ToString(CultureInfo.CurrentCulture) + " more")
            {
                Enabled = false,
                Tag = new RowLook { Text = SystemColors.GrayText },
            });
        int at = menu.Items.IndexOf(controlsSeparator);
        foreach (ToolStripItem row in added) menu.Items.Insert(at++, row);
        rows.AddRange(added);
        menu.ResumeLayout();
    }

    private void Tick()
    {
        DateTime now = DateTime.UtcNow;
        foreach (var clock in clocks) clock.Key.ShortcutKeyDisplayString = TrayText.Duration(clock.Value, now);
    }

    private static string Shorten(string text, int length)
    {
        return text.Length <= length ? text : text.Substring(0, length - 1).TrimEnd() + "\u2026";
    }

    private async Task Quit()
    {
        if (stopping || closed) return;
        stopping = true;
        quit.Enabled = false;
        quit.Text = "Quitting Happy...";
        status.Text = "Quitting Happy...";
        icon.Text = "Quitting Happy";
        try
        {
            await Task.Run(delegate {
                client.QuitDesktop();
                client.Stop();
            });
        }
        catch (Exception)
        {
            if (!closed) {
                stopping = false;
                quit.Enabled = true;
                quit.Text = "Quit Happy";
                icon.Text = "Happy Agent is running";
                MessageBox.Show("Happy could not quit. Close Happy Desktop and try again.",
                    "Could not quit Happy", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Refresh();
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
        clockTimer.Dispose();
        icon.Visible = false;
        icon.Icon.Dispose();
        icon.Dispose();
        menu.Dispose();
        headerFont.Dispose();
        dispatch.Dispose();
        base.ExitThreadCore();
    }

    private static Icon CreateIcon()
    {
        // The official Happy logo, embedded in the executable as a multi-size icon. Asking for the
        // system's small icon size picks the closest stored image, so it stays sharp on HiDPI.
        using (var stream = typeof(WindowsTray).Assembly.GetManifestResourceStream("happy.ico"))
            return new Icon(stream, SystemInformation.SmallIconSize);
    }
}

/// <summary>
/// How a read-only row draws. Rows are disabled menu items, so they never highlight or close the
/// menu, and the renderer draws their text in these colors instead of the disabled grey.
/// </summary>
internal sealed class RowLook
{
    public Color Text;
    /// <summary>The right-hand cells, or null to draw the shortcut text as one quiet detail.</summary>
    public List<Cell> Cells;
    /// <summary>The cells' total width, which the item's shortcut text reserves.</summary>
    public int CellsWidth;
}

internal sealed class Cell
{
    public string Text;
    public Color Color;
    public int Width;
    public bool AlignRight;
    public Font Font;
}

/// <summary>
/// One vendor's columns, measured right to left from the reset so the same window lines up under
/// every vendor: the plan, a percentage left per window, and the reset of the window holding the
/// account back.
/// </summary>
internal sealed class PlanColumns
{
    public const int Gap = 14;
    private static readonly Color Red = Color.FromArgb(0xC4, 0x2B, 0x1C);
    private static readonly Color Yellow = Color.FromArgb(0xE0, 0xA1, 0x00);
    private readonly Font font;
    private readonly Font headerFont;
    private readonly List<PlanWindowKind> columns;
    private readonly int planWidth;
    private readonly int percentWidth;
    private readonly int resetWidth;

    public PlanColumns(PlanVendor vendor, Font font, Font headerFont)
    {
        this.font = font;
        this.headerFont = headerFont;
        columns = vendor.Columns;
        int widest = 0;
        foreach (PlanEntry entry in vendor.Plans)
            if (entry.PlanName != null) widest = Math.Max(widest, Measure(entry.PlanName, font));
        // The plan column is as wide as the vendor's widest plan, never narrower than its header
        // and never wider than a long plan name such as "SuperGrok Heavy" needs.
        planWidth = widest == 0 ? 0 : Math.Min(Math.Max(widest, Measure("Plan", headerFont)), Measure("SuperGrok Heavy", font));
        percentWidth = Math.Max(Measure("100%", font), Measure("Session", headerFont));
        resetWidth = Math.Max(Measure(new DateTime(2026, 1, 1, 22, 58, 0).ToString("t", CultureInfo.CurrentCulture), font), Measure("Resets", headerFont));
    }

    public bool SameAs(PlanColumns other)
    {
        if (other.planWidth != planWidth || other.columns.Count != columns.Count) return false;
        for (int i = 0; i < columns.Count; i++) if (other.columns[i] != columns[i]) return false;
        return true;
    }

    public ToolStripMenuItem Header(PlanVendor vendor, bool labels)
    {
        var cells = new List<Cell>();
        if (labels)
        {
            if (planWidth > 0) cells.Add(new Cell { Text = "Plan", Width = planWidth });
            foreach (PlanWindowKind kind in columns) cells.Add(new Cell { Text = PlanWindow.Label(kind), Width = percentWidth, AlignRight = true });
            cells.Add(new Cell { Text = "Resets", Width = resetWidth, AlignRight = true });
            foreach (Cell cell in cells) { cell.Color = SystemColors.GrayText; cell.Font = headerFont; }
        }
        return Item(vendor.Name.ToUpper(CultureInfo.CurrentCulture), SystemColors.GrayText, cells, null);
    }

    public ToolStripMenuItem Row(PlanEntry entry, DateTime now, Size imageSize)
    {
        var cells = new List<Cell>();
        if (planWidth > 0) cells.Add(new Cell { Text = entry.PlanName ?? "", Color = SystemColors.GrayText, Width = planWidth });
        foreach (PlanWindowKind kind in columns)
        {
            PlanWindow window = entry.Window(kind);
            string text = window == null ? (entry.IsPlaceholder ? "\u2013" : "") : Math.Round(window.Left).ToString(CultureInfo.CurrentCulture) + "%";
            bool red = window != null && (entry.IsBlocking(window) || window.Left < 10);
            cells.Add(new Cell { Text = text, Color = red ? Red : SystemColors.GrayText, Width = percentWidth, AlignRight = true });
        }
        PlanWindow limiting = entry.Limiting;
        string reset = limiting != null && limiting.ResetsAt.HasValue ? TrayText.Reset(limiting.ResetsAt.Value, now, false) : "";
        cells.Add(new Cell { Text = reset, Color = entry.IsBlocked ? Red : SystemColors.GrayText, Width = resetWidth, AlignRight = true });
        foreach (Cell cell in cells) cell.Font = font;
        ToolStripMenuItem item = Item(entry.Name.Length > 40 ? entry.Name.Substring(0, 39).TrimEnd() + "\u2026" : entry.Name,
            SystemColors.MenuText, cells, TrayText.Tooltip(entry, now));
        item.Image = Ring(entry, imageSize);
        return item;
    }

    private ToolStripMenuItem Item(string text, Color color, List<Cell> cells, string tooltip)
    {
        int width = 0;
        foreach (Cell cell in cells) width += cell.Width + Gap;
        // Windows sizes the shortcut column from the shortcut text, so the text reserves the cells'
        // width; it reads sensibly on its own should a theme draw it as plain text.
        string reserve = "";
        foreach (Cell cell in cells) if (cell.Text.Length > 0) reserve += (reserve.Length == 0 ? "" : "  ") + cell.Text;
        for (int guard = 0; guard < 200 && Measure(reserve, font) < width; guard++) reserve += "\u2007";
        return new ToolStripMenuItem(text)
        {
            Enabled = false,
            ShortcutKeyDisplayString = cells.Count == 0 ? null : reserve,
            ToolTipText = tooltip,
            AutoToolTip = false,
            Tag = new RowLook { Text = color, Cells = cells, CellsWidth = width },
        };
    }

    /// <summary>
    /// A small ring for the window holding the account back, filled with what is left like a
    /// battery: grey with room to spare, yellow under 25% left, red under 10% or while blocked.
    /// </summary>
    private static Bitmap Ring(PlanEntry entry, Size size)
    {
        var image = new Bitmap(size.Width, size.Height);
        using (Graphics g = Graphics.FromImage(image))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float line = Math.Max(2f, size.Width / 8f);
            var bounds = new RectangleF(line, line, size.Width - line * 2 - 1, size.Height - line * 2 - 1);
            using (var track = new Pen(Color.FromArgb(70, SystemColors.GrayText), line))
                g.DrawEllipse(track, bounds);
            PlanWindow limiting = entry.Limiting;
            if (limiting != null && limiting.Left > 0)
            {
                bool blocked = entry.IsBlocked;
                Color color = blocked || limiting.Left < 10 ? Red : limiting.Left < 25 ? Yellow : SystemColors.GrayText;
                using (var arc = new Pen(color, line))
                    g.DrawArc(arc, bounds, -90, (float)(360 * limiting.Left / 100));
            }
        }
        return image;
    }

    private static int Measure(string text, Font font)
    {
        return TextRenderer.MeasureText(text, font, Size.Empty, TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Width;
    }
}

/// <summary>
/// The standard menu look, except that read-only rows draw in their own colors, never highlight,
/// keep their colored ring, and lay their right-hand text out in columns.
/// </summary>
internal sealed class TrayRenderer : ToolStripProfessionalRenderer
{
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        if (e.Item.Tag is RowLook) return;
        base.OnRenderMenuItemBackground(e);
    }

    protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e)
    {
        if (e.Item.Tag is RowLook && e.Image != null) { e.Graphics.DrawImage(e.Image, e.ImageRectangle); return; }
        base.OnRenderItemImage(e);
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        var look = e.Item.Tag as RowLook;
        if (look == null) { base.OnRenderItemText(e); return; }
        if (e.Text == e.Item.Text)
        {
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, look.Text, e.TextFormat | TextFormatFlags.EndEllipsis);
            return;
        }
        if (look.Cells == null || look.Cells.Count == 0)
        {
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, SystemColors.GrayText, e.TextFormat);
            return;
        }
        // Columns are anchored to the right edge, which every row in the menu shares.
        int x = e.TextRectangle.Right - look.CellsWidth + PlanColumns.Gap;
        foreach (Cell cell in look.Cells)
        {
            var bounds = new Rectangle(x, e.TextRectangle.Top, cell.Width, e.TextRectangle.Height);
            TextFormatFlags flags = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding |
                TextFormatFlags.EndEllipsis | (cell.AlignRight ? TextFormatFlags.Right : TextFormatFlags.Left);
            TextRenderer.DrawText(e.Graphics, cell.Text, cell.Font ?? e.TextFont, bounds, cell.Color, flags);
            x += cell.Width + PlanColumns.Gap;
        }
    }
}
