using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;

// The Windows daemon's existing private named-pipe HTTP API. No TCP port or new API is needed.
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

    public DaemonUsage Usage()
    {
        using (var body = new MemoryStream(Request("GET", "/v0/usage", 200)))
            return (DaemonUsage)new DataContractJsonSerializer(typeof(DaemonUsage),
                new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true }).ReadObject(body);
    }

    public void Stop() { Request("POST", "/v0/shutdown", 202); }

    private byte[] Request(string method, string path, int expectedStatus)
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

// Only the fields displayed by this client, from GET /v0/usage. Unrecognized additive fields
// remain the server's concern; missing provider readings are displayed as unavailable, never zero.
[DataContract] internal sealed class DaemonUsage
{
    [DataMember(Name = "providers")] public UsageProvider[] Providers { get; set; }
    [DataMember(Name = "day")] public Dictionary<string, Dictionary<string, TokenTotals>> Day { get; set; }
}
[DataContract] internal sealed class UsageProvider
{
    [DataMember(Name = "providerId")] public string Id { get; set; }
    [DataMember(Name = "enabled")] public bool Enabled { get; set; }
    [DataMember(Name = "usage")] public ProviderUsage Usage { get; set; }
}
[DataContract] internal sealed class ProviderUsage
{
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
