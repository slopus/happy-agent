using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;

// The Windows daemon's existing private named-pipe HTTP API. No TCP port or new API is needed.
//
// This file is compiled by the .NET Framework's own csc.exe, which accepts C# 5 only, and is read in
// the system code page: keep it to C# 5 syntax and ASCII source, with \u escapes for anything else.
internal sealed class DaemonClient
{
    private readonly string pipeName;
    private readonly string tokenFile;
    public DaemonClient(string socket, string tokenFile)
    {
        const string prefix = @"\\.\pipe\";
        if (!socket.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The Windows tray requires the local daemon named pipe.");
        this.pipeName = socket.Substring(prefix.Length);
        this.tokenFile = tokenFile;
    }

    /// <summary>
    /// Every account's latest reading, in configuration order. Friendly names come from the
    /// configuration; when it cannot be read, names stay null and the tray keeps the ones it knew.
    /// </summary>
    public DaemonUsage Usage(bool refreshAccounts)
    {
        if (refreshAccounts) Request("POST", "/v0/usage/refresh", 202, false);
        DaemonUsage usage = Read<DaemonUsage>(Request("GET", "/v0/usage", 200, false));
        try
        {
            var configuration = Read<DaemonConfiguration>(Request("GET", "/v0/config", 200, false));
            foreach (var provider in usage.Providers ?? new UsageProvider[0])
            {
                ConfiguredProvider configured;
                if (configuration.Config != null && configuration.Config.Providers != null &&
                    provider.Id != null &&
                    configuration.Config.Providers.TryGetValue(provider.Id, out configured))
                {
                    provider.Name = configured.Name;
                    if (configured.Hidden == true) provider.Hidden = true;
                }
                provider.Configured = true;
            }
        }
        catch (Exception) { }
        return usage;
    }

    /// <summary>
    /// The bots and the person's joined tasks. A daemon without tasks answers 404 on the task list,
    /// which leaves the bots alone rather than looking like a lost connection.
    /// </summary>
    public WorkRow[] Work(out WorkRow[] tasks)
    {
        WorkList bots = Read<WorkList>(Request("GET", "/v0/bots", 200, false));
        byte[] taskBody = Request("GET", "/v0/tasks?scope=joined", 200, true);
        tasks = taskBody == null ? new WorkRow[0] : (Read<WorkList>(taskBody).Tasks ?? new WorkRow[0]);
        return bots.Bots ?? new WorkRow[0];
    }

    /// <summary>
    /// When the newest running turn in an agent's history began, in Unix milliseconds: the same
    /// startedAt the desktop counts its running-turn clock from.
    /// </summary>
    public long? RunningTurnStart(string agentId)
    {
        MessagesPage page = Read<MessagesPage>(Request("GET",
            "/v0/agents/" + Uri.EscapeDataString(agentId) + "/messages?limit=1&omitToolData=true", 200, false));
        long? newest = null;
        foreach (RunInfo run in page.Runs ?? new RunInfo[0])
            if (run.Status == "running" && run.StartedAt.HasValue && (!newest.HasValue || run.StartedAt > newest))
                newest = run.StartedAt;
        return newest;
    }

    public void Stop() { Request("POST", "/v0/shutdown", 202, false); }

    // Desktop advertises a private, authenticated quit pipe beside this daemon's token.
    // It holds the connection open until its process exits, after flushing window state.
    public void QuitDesktop()
    {
        string directory = Path.Combine(Path.GetDirectoryName(tokenFile), "desktop-quit");
        if (!Directory.Exists(directory)) return;
        foreach (string file in Directory.GetFiles(directory, "*.json"))
        {
            DesktopQuitEndpoint endpoint = Read<DesktopQuitEndpoint>(File.ReadAllBytes(file));
            if (endpoint.Pid <= 0 || endpoint.Token == null || endpoint.Token.Length != 64 ||
                endpoint.SocketPath == null || !endpoint.SocketPath.StartsWith(@"\\.\pipe\happy-desktop-quit-", StringComparison.Ordinal))
                throw new IOException("Happy Desktop's quit connection is unavailable.");
            try { using (Process desktop = Process.GetProcessById(endpoint.Pid)) { if (desktop.HasExited) continue; } }
            catch (ArgumentException) { continue; }
            using (var pipe = new NamedPipeClientStream(".", endpoint.SocketPath.Substring(9), PipeDirection.InOut))
            using (var timeout = new Timer(delegate { pipe.Dispose(); }, null, 15000, Timeout.Infinite))
            {
                pipe.Connect(2000);
                byte[] request = Encoding.ASCII.GetBytes(endpoint.Token + "\n");
                pipe.Write(request, 0, request.Length);
                using (var reader = new StreamReader(pipe, Encoding.ASCII))
                {
                    if (reader.ReadLine() != "quitting") throw new IOException("Happy Desktop could not quit.");
                    if (reader.Read() != -1) throw new IOException("Happy Desktop is still closing. Please try again.");
                }
            }
        }
    }

    private static T Read<T>(byte[] body)
    {
        using (var stream = new MemoryStream(body))
            return (T)new DataContractJsonSerializer(typeof(T),
                new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true }).ReadObject(stream);
    }

    /// <summary>The response body, or null for a 404 when <paramref name="allowNotFound"/>.</summary>
    private byte[] Request(string method, string path, int expectedStatus, bool allowNotFound)
    {
        string token = File.ReadAllText(tokenFile).Trim();
        if (token.Length == 0 || token.Contains("\r") || token.Contains("\n"))
            throw new IOException("The daemon token is unavailable.");
        using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
        using (var timeout = new Timer(delegate { pipe.Dispose(); }, null, 5000, Timeout.Infinite))
        {
            pipe.Connect(2000);
            byte[] request = Encoding.UTF8.GetBytes(method + " " + path + " HTTP/1.1\r\n" +
                "Host: happy-agent\r\nAuthorization: Bearer " + token +
                "\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            pipe.Write(request, 0, request.Length);
            using (var response = new MemoryStream())
            {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = pipe.Read(buffer, 0, buffer.Length)) != 0)
                {
                    if (response.Length + count > 4 * 1024 * 1024)
                        throw new IOException("The daemon response is too large.");
                    response.Write(buffer, 0, count);
                }
                byte[] bytes = response.ToArray();
                string text = Encoding.UTF8.GetString(bytes);
                int split = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                if (split < 0) throw new IOException("The daemon response is incomplete.");
                string header = text.Substring(0, split);
                string[] status = header.Split('\r')[0].Split(' ');
                if (allowNotFound && status.Length >= 2 && status[1] == "404") return null;
                if (status.Length < 2 || status[1] != expectedStatus.ToString())
                    throw new IOException("The daemon could not complete the request.");
                int offset = Encoding.UTF8.GetByteCount(text.Substring(0, split + 4));
                using (var body = new MemoryStream())
                {
                    if (header.IndexOf("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        while (true)
                        {
                            int end = offset;
                            while (end + 1 < bytes.Length && !(bytes[end] == 13 && bytes[end + 1] == 10)) end++;
                            if (end + 1 >= bytes.Length) throw new IOException("Incomplete response chunk.");
                            string size = Encoding.ASCII.GetString(bytes, offset, end - offset).Split(';')[0];
                            int length = Convert.ToInt32(size, 16);
                            offset = end + 2;
                            if (length == 0) break;
                            if (length < 0 || length > bytes.Length - offset - 2)
                                throw new IOException("Invalid response chunk.");
                            body.Write(bytes, offset, length);
                            offset += length + 2;
                        }
                    }
                    else body.Write(bytes, offset, bytes.Length - offset);
                    return body.ToArray();
                }
            }
        }
    }
}

[DataContract] internal sealed class DesktopQuitEndpoint
{
    [DataMember(Name = "pid")] public int Pid { get; set; }
    [DataMember(Name = "socketPath")] public string SocketPath { get; set; }
    [DataMember(Name = "token")] public string Token { get; set; }
}

// Only the fields displayed by this client. Unrecognized additive fields remain the server's
// concern; a missing provider reading is shown as waiting, never as zero.
[DataContract] internal sealed class DaemonUsage
{
    [DataMember(Name = "providers")] public UsageProvider[] Providers { get; set; }
    [DataMember(Name = "day")] public Dictionary<string, Dictionary<string, TokenTotals>> Day { get; set; }
}
[DataContract] internal sealed class UsageProvider
{
    /// <summary>The configured friendly name, or null when configuration could not be read.</summary>
    public string Name { get; set; }
    /// <summary>Whether configuration was read alongside this reading.</summary>
    public bool Configured { get; set; }
    [DataMember(Name = "type")] public string Type { get; set; }
    [DataMember(Name = "providerId")] public string Id { get; set; }
    [DataMember(Name = "enabled")] public bool? Enabled { get; set; }
    [DataMember(Name = "hidden")] public bool? Hidden { get; set; }
    [DataMember(Name = "usage")] public ProviderUsage Usage { get; set; }
    [DataMember(Name = "checkedAt")] public long? CheckedAt { get; set; }
    [DataMember(Name = "refreshing")] public bool? Refreshing { get; set; }
}
[DataContract] internal sealed class DaemonConfiguration
{
    [DataMember(Name = "config")] public EffectiveConfiguration Config { get; set; }
}
[DataContract] internal sealed class EffectiveConfiguration
{
    [DataMember(Name = "providers")] public Dictionary<string, ConfiguredProvider> Providers { get; set; }
}
[DataContract] internal sealed class ConfiguredProvider
{
    [DataMember(Name = "name")] public string Name { get; set; }
    [DataMember(Name = "hidden")] public bool? Hidden { get; set; }
}
[DataContract] internal sealed class ProviderUsage
{
    [DataMember(Name = "planName")] public string PlanName { get; set; }
    [DataMember(Name = "exhausted")] public bool? Exhausted { get; set; }
    [DataMember(Name = "windows")] public UsageWindows Windows { get; set; }
}
[DataContract] internal sealed class UsageWindows
{
    [DataMember(Name = "fiveHour")] public UsageWindow Session { get; set; }
    [DataMember(Name = "weekly")] public UsageWindow Week { get; set; }
    [DataMember(Name = "fableWeekly")] public UsageWindow Fable { get; set; }
    [DataMember(Name = "monthly")] public UsageWindow Month { get; set; }
}
[DataContract] internal sealed class UsageWindow
{
    [DataMember(Name = "usedPercent")] public double UsedPercent { get; set; }
    [DataMember(Name = "resetsAt")] public long? ResetsAt { get; set; }
}
[DataContract] internal sealed class TokenTotals
{
    [DataMember(Name = "input")] public long Input { get; set; }
    [DataMember(Name = "output")] public long Output { get; set; }
}

// GET /v0/bots and GET /v0/tasks?scope=joined: a bot or task with its agent tree.
[DataContract] internal sealed class WorkList
{
    [DataMember(Name = "bots")] public WorkRow[] Bots { get; set; }
    [DataMember(Name = "tasks")] public WorkRow[] Tasks { get; set; }
}
[DataContract] internal sealed class WorkRow
{
    [DataMember(Name = "id")] public string Id { get; set; }
    [DataMember(Name = "name")] public string Name { get; set; }
    [DataMember(Name = "status")] public string Status { get; set; }
    [DataMember(Name = "creatorAgentId")] public string CreatorAgentId { get; set; }
    [DataMember(Name = "agent")] public AgentNode Agent { get; set; }
}
[DataContract] internal sealed class AgentNode
{
    [DataMember(Name = "id")] public string Id { get; set; }
    [DataMember(Name = "status")] public string Status { get; set; }
    [DataMember(Name = "subagents")] public SubagentCounts Subagents { get; set; }
    [DataMember(Name = "subtasks")] public AgentNode[] Subtasks { get; set; }
}
[DataContract] internal sealed class SubagentCounts
{
    [DataMember(Name = "running")] public int Running { get; set; }
}

// GET /v0/agents/:id/messages: only the runs, for when the running turn began.
[DataContract] internal sealed class MessagesPage
{
    [DataMember(Name = "runs")] public RunInfo[] Runs { get; set; }
}
[DataContract] internal sealed class RunInfo
{
    [DataMember(Name = "status")] public string Status { get; set; }
    [DataMember(Name = "startedAt")] public long? StartedAt { get; set; }
}
