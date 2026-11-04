#define _GNU_SOURCE
#include <curl/curl.h>
#include <gio/gio.h>
#include <glib-unix.h>
#include <json-glib/json-glib.h>
#include <errno.h>
#include <signal.h>
#include <sys/prctl.h>
#include <unistd.h>

/* A native StatusNotifierItem and DBusMenu: no X11 dependency and no window. */
static const char *socket_path, *token_path;
static GDBusConnection *bus;
static GMainLoop *loop;
static gboolean quitting, refreshing;
static guint revision = 1;
static guint quit_generation;
static char *headline;
static const char *watcher = "org.kde.StatusNotifierWatcher";
static const char *item_path = "/StatusNotifierItem";
static const char *menu_path = "/MenuBar";

static const char introspection[] =
    "<node><interface name='org.kde.StatusNotifierItem'>"
    "<property name='Category' type='s' access='read'/>"
    "<property name='Id' type='s' access='read'/>"
    "<property name='Title' type='s' access='read'/>"
    "<property name='Status' type='s' access='read'/>"
    "<property name='WindowId' type='i' access='read'/>"
    "<property name='IconName' type='s' access='read'/>"
    "<property name='IconPixmap' type='a(iiay)' access='read'/>"
    "<property name='ItemIsMenu' type='b' access='read'/>"
    "<property name='Menu' type='o' access='read'/>"
    "<method name='ContextMenu'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
    "<method name='Activate'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
    "<method name='SecondaryActivate'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
    "<method name='Scroll'><arg type='i' direction='in'/><arg type='s' direction='in'/></method>"
    "</interface><interface name='com.canonical.dbusmenu'>"
    "<property name='Version' type='u' access='read'/>"
    "<property name='TextDirection' type='s' access='read'/>"
    "<property name='Status' type='s' access='read'/>"
    "<property name='IconThemePath' type='as' access='read'/>"
    "<method name='GetLayout'><arg type='i' direction='in'/><arg type='i' direction='in'/>"
    "<arg type='as' direction='in'/><arg type='u' direction='out'/><arg type='(ia{sv}av)' direction='out'/></method>"
    "<method name='GetGroupProperties'><arg type='ai' direction='in'/><arg type='as' direction='in'/>"
    "<arg type='a(ia{sv})' direction='out'/></method>"
    "<method name='GetProperty'><arg type='i' direction='in'/><arg type='s' direction='in'/>"
    "<arg type='v' direction='out'/></method>"
    "<method name='Event'><arg type='i' direction='in'/><arg type='s' direction='in'/>"
    "<arg type='v' direction='in'/><arg type='u' direction='in'/></method>"
    "<method name='EventGroup'><arg type='a(isvu)' direction='in'/><arg type='ai' direction='out'/></method>"
    "<method name='AboutToShow'><arg type='i' direction='in'/><arg type='b' direction='out'/></method>"
    "<method name='AboutToShowGroup'><arg type='ai' direction='in'/><arg type='ai' direction='out'/>"
    "<arg type='ai' direction='out'/></method>"
    "<signal name='LayoutUpdated'><arg type='u'/><arg type='i'/></signal>"
    "</interface></node>";

static void changed(void) {
    g_dbus_connection_emit_signal(bus, NULL, menu_path, "com.canonical.dbusmenu",
        "LayoutUpdated", g_variant_new("(ui)", ++revision, 0), NULL);
}

static GVariant *properties(int id) {
    GVariantBuilder props;
    g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
    if (id == 0) g_variant_builder_add(&props, "{sv}", "children-display", g_variant_new_string("submenu"));
    if (id == 1 || id == 3) {
        g_variant_builder_add(&props, "{sv}", "label", g_variant_new_string(
            id == 1 ? headline : quitting ? "Quitting Happy…" : "Quit Happy"));
        g_variant_builder_add(&props, "{sv}", "enabled", g_variant_new_boolean(id == 3 && !quitting));
    }
    if (id == 2) g_variant_builder_add(&props, "{sv}", "type", g_variant_new_string("separator"));
    return g_variant_builder_end(&props);
}

static GVariant *layout(int id, int depth) {
    GVariantBuilder children;
    g_variant_builder_init(&children, G_VARIANT_TYPE("av"));
    if (id == 0 && depth != 0)
        for (int child = 1; child <= 3; child++)
            g_variant_builder_add(&children, "v", layout(child, depth < 0 ? -1 : depth - 1));
    return g_variant_new("(i@a{sv}@av)", id, properties(id), g_variant_builder_end(&children));
}

static size_t receive_body(char *data, size_t size, size_t count, void *target) {
    GString *body = target;
    size_t length = size * count;
    if (length > 4 * 1024 * 1024 - body->len) return 0;
    g_string_append_len(body, data, length);
    return length;
}

static JsonParser *request(const char *method, const char *path, long expected, GError **error) {
    g_autofree char *token = NULL;
    if (!g_file_get_contents(token_path, &token, NULL, error)) return NULL;
    g_strstrip(token);
    if (!*token || strpbrk(token, "\r\n")) {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Happy Agent's token is unavailable.");
        return NULL;
    }
    CURL *curl = curl_easy_init();
    g_autoptr(GString) body = g_string_new(NULL);
    g_autofree char *url = g_strconcat("http://localhost", path, NULL);
    g_autofree char *authorization = g_strconcat("Authorization: Bearer ", token, NULL);
    struct curl_slist *headers = curl_slist_append(NULL, authorization);
    curl_easy_setopt(curl, CURLOPT_UNIX_SOCKET_PATH, socket_path);
    curl_easy_setopt(curl, CURLOPT_PROXY, "");
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method);
    if (g_str_equal(method, "POST")) curl_easy_setopt(curl, CURLOPT_POSTFIELDS, "");
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 2L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive_body);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, body);
    CURLcode result = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    if (result != CURLE_OK || status != expected) {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Happy Agent could not complete the request.");
        return NULL;
    }
    JsonParser *parser = json_parser_new();
    if (!json_parser_load_from_data(parser, body->str, body->len, error)) { g_object_unref(parser); return NULL; }
    return parser;
}

static const char *text(JsonObject *object, const char *key) {
    JsonNode *node = json_object_get_member(object, key);
    return node && json_node_get_value_type(node) == G_TYPE_STRING ? json_node_get_string(node) : NULL;
}

static JsonArray *array(JsonObject *object, const char *key) {
    JsonNode *node = json_object_get_member(object, key);
    return node && JSON_NODE_HOLDS_ARRAY(node) ? json_node_get_array(node) : NULL;
}

static JsonObject *object_member(JsonObject *object, const char *key) {
    JsonNode *node = json_object_get_member(object, key);
    return node && JSON_NODE_HOLDS_OBJECT(node) ? json_node_get_object(node) : NULL;
}

static gboolean working(JsonObject *agent) {
    if (!agent) return FALSE;
    const char *status = text(agent, "status");
    if (status && !g_str_equal(status, "idle")) return TRUE;
    JsonObject *subagents = object_member(agent, "subagents");
    if (subagents && json_object_has_member(subagents, "running") && json_object_get_int_member(subagents, "running") > 0) return TRUE;
    JsonArray *subtasks = array(agent, "subtasks");
    for (guint i = 0; subtasks && i < json_array_get_length(subtasks); i++)
        if (working(json_array_get_object_element(subtasks, i))) return TRUE;
    return FALSE;
}

static void collect_ids(JsonObject *agent, GHashTable *ids) {
    if (!agent) return;
    const char *id = text(agent, "id");
    if (id) g_hash_table_add(ids, g_strdup(id));
    JsonArray *subtasks = array(agent, "subtasks");
    for (guint i = 0; subtasks && i < json_array_get_length(subtasks); i++)
        collect_ids(json_array_get_object_element(subtasks, i), ids);
}

static int working_count(JsonParser *bots, JsonParser *tasks) {
    JsonNode *bots_root = json_parser_get_root(bots), *tasks_root = json_parser_get_root(tasks);
    if (!JSON_NODE_HOLDS_OBJECT(bots_root) || !JSON_NODE_HOLDS_OBJECT(tasks_root)) return -1;
    JsonArray *lists[] = { array(json_node_get_object(bots_root), "bots"), array(json_node_get_object(tasks_root), "tasks") };
    if (!lists[0] || !lists[1]) return -1;
    g_autoptr(GHashTable) ids = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    for (guint i = 0; i < json_array_get_length(lists[1]); i++)
        collect_ids(object_member(json_array_get_object_element(lists[1], i), "agent"), ids);
    int count = 0;
    for (int list = 0; list < 2; list++)
        for (guint i = 0; i < json_array_get_length(lists[list]); i++) {
            JsonObject *row = json_array_get_object_element(lists[list], i);
            const char *creator = text(row, "creatorAgentId");
            if (list == 1 && creator && g_hash_table_contains(ids, creator)) continue;
            if (g_strcmp0(text(row, "status"), "active") == 0 && working(object_member(row, "agent"))) count++;
        }
    return count;
}

/* Only endpoints advertised by Desktop for this installation are contacted. A successful
 * connection stays open until Desktop's process exits, so state is flushed before shutdown. */
static gboolean quit_desktop(GError **error) {
    g_autofree char *parent = g_path_get_dirname(token_path);
    g_autofree char *directory = g_build_filename(parent, "desktop-quit", NULL);
    if (!g_file_test(directory, G_FILE_TEST_IS_DIR)) return TRUE;
    g_autoptr(GDir) entries = g_dir_open(directory, 0, error);
    if (!entries) return FALSE;
    const char *name;
    int endpoints = 0;
    while ((name = g_dir_read_name(entries))) {
        if (!g_str_has_suffix(name, ".json")) continue;
        if (++endpoints > 32) goto failed;
        g_autofree char *file = g_build_filename(directory, name, NULL);
        g_autoptr(JsonParser) parser = json_parser_new();
        if (!json_parser_load_from_file(parser, file, error)) return FALSE;
        JsonNode *root = json_parser_get_root(parser);
        if (!JSON_NODE_HOLDS_OBJECT(root)) goto failed;
        JsonObject *endpoint = json_node_get_object(root);
        const char *path = text(endpoint, "socketPath"), *token = text(endpoint, "token");
        if (!path || !g_path_is_absolute(path) || !token || strlen(token) != 64 || strpbrk(token, "\r\n")) goto failed;
        if (!g_file_test(path, G_FILE_TEST_EXISTS)) continue; /* stale registration after a crash */
        g_autoptr(GSocketClient) client = g_socket_client_new();
        g_socket_client_set_timeout(client, 15);
        g_autoptr(GSocketAddress) address = g_unix_socket_address_new(path);
        g_autoptr(GSocketConnection) connection = g_socket_client_connect(client, G_SOCKET_CONNECTABLE(address), NULL, error);
        if (!connection) return FALSE;
        g_autofree char *message = g_strconcat(token, "\n", NULL);
        if (!g_output_stream_write_all(g_io_stream_get_output_stream(G_IO_STREAM(connection)), message, strlen(message), NULL, NULL, error)) return FALSE;
        g_autoptr(GDataInputStream) input = g_data_input_stream_new(g_io_stream_get_input_stream(G_IO_STREAM(connection)));
        g_autofree char *reply = g_data_input_stream_read_line(input, NULL, NULL, error);
        if (g_strcmp0(reply, "quitting") != 0) goto failed;
        char extra;
        if (g_input_stream_read(G_INPUT_STREAM(input), &extra, 1, NULL, error) != 0) goto failed;
    }
    return TRUE;
failed:
    if (error && !*error) g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Happy Desktop could not quit. Please try again.");
    return FALSE;
}

static void read_work(GTask *task, gpointer source, gpointer data, GCancellable *cancel) {
    (void)source; (void)data; (void)cancel;
    g_autoptr(JsonParser) bots = request("GET", "/v0/bots", 200, NULL);
    g_autoptr(JsonParser) tasks = request("GET", "/v0/tasks?scope=joined", 200, NULL);
    int count = bots && tasks ? working_count(bots, tasks) : -1;
    g_task_return_pointer(task, count < 0 ? g_strdup("Happy Agent is not responding") : count == 0 ? g_strdup("All idle") : g_strdup_printf("%d working", count), g_free);
}

static void refreshed(GObject *source, GAsyncResult *result, gpointer data) {
    (void)source; (void)data;
    g_autofree char *value = g_task_propagate_pointer(G_TASK(result), NULL);
    refreshing = FALSE;
    if (!quitting && GPOINTER_TO_UINT(g_task_get_task_data(G_TASK(result))) == quit_generation) {
        g_free(headline); headline = g_strdup(value); changed();
    }
}

static void refresh(void) {
    if (refreshing || quitting) return;
    refreshing = TRUE;
    g_autoptr(GTask) task = g_task_new(NULL, NULL, refreshed, NULL);
    g_task_set_task_data(task, GUINT_TO_POINTER(quit_generation), NULL);
    g_task_run_in_thread(task, read_work);
}

static void quit_work(GTask *task, gpointer source, gpointer data, GCancellable *cancel) {
    (void)source; (void)data; (void)cancel;
    GError *error = NULL;
    if (quit_desktop(&error)) {
        g_autoptr(JsonParser) response = request("POST", "/v0/shutdown", 202, &error);
    }
    if (error) g_task_return_error(task, error); else g_task_return_boolean(task, TRUE);
}

static void quit_done(GObject *source, GAsyncResult *result, gpointer data) {
    (void)source; (void)data;
    g_autoptr(GError) error = NULL;
    if (!g_task_propagate_boolean(G_TASK(result), &error)) {
        quitting = FALSE;
        g_free(headline);
        headline = g_strdup("Could not quit Happy. Please try again.");
        g_printerr("Happy tray: %s\n", error->message);
        changed();
    }
}

static void event(GVariant *args) {
    int id; const char *name;
    g_variant_get_child(args, 0, "i", &id);
    g_variant_get_child(args, 1, "&s", &name);
    if (id != 3 || !g_str_equal(name, "clicked") || quitting) return;
    quitting = TRUE;
    quit_generation++;
    changed();
    g_autoptr(GTask) task = g_task_new(NULL, NULL, quit_done, NULL);
    g_task_run_in_thread(task, quit_work);
}

static void method(GDBusConnection *connection, const char *sender, const char *path,
    const char *interface, const char *name, GVariant *args, GDBusMethodInvocation *call, gpointer data) {
    (void)connection; (void)sender; (void)path; (void)data;
    if (g_str_equal(interface, "org.kde.StatusNotifierItem")) {
        refresh();
        g_dbus_method_invocation_return_value(call, NULL);
    } else if (g_str_equal(name, "GetLayout")) {
        int id, depth;
        g_variant_get_child(args, 0, "i", &id);
        g_variant_get_child(args, 1, "i", &depth);
        g_dbus_method_invocation_return_value(call, g_variant_new("(u@(ia{sv}av))", revision, layout(id, depth)));
    } else if (g_str_equal(name, "GetGroupProperties")) {
        g_autoptr(GVariant) ids = g_variant_get_child_value(args, 0);
        GVariantBuilder rows; g_variant_builder_init(&rows, G_VARIANT_TYPE("a(ia{sv})"));
        GVariantIter iter; int id; g_variant_iter_init(&iter, ids);
        while (g_variant_iter_next(&iter, "i", &id))
            if (id >= 0 && id <= 3) g_variant_builder_add(&rows, "(i@a{sv})", id, properties(id));
        g_dbus_method_invocation_return_value(call, g_variant_new("(@a(ia{sv}))", g_variant_builder_end(&rows)));
    } else if (g_str_equal(name, "GetProperty")) {
        int id; const char *key; g_variant_get(args, "(i&s)", &id, &key);
        g_autoptr(GVariant) props = g_variant_ref_sink(properties(id));
        g_autoptr(GVariant) value = g_variant_lookup_value(props, key, NULL);
        if (value) g_dbus_method_invocation_return_value(call, g_variant_new("(v)", value));
        else g_dbus_method_invocation_return_dbus_error(call, "com.canonical.dbusmenu.Error", "Unknown property");
    } else if (g_str_equal(name, "AboutToShow") || g_str_equal(name, "AboutToShowGroup")) {
        refresh();
        g_dbus_method_invocation_return_value(call, g_str_equal(name, "AboutToShow") ? g_variant_new("(b)", FALSE) : g_variant_new("(aiai)", NULL, NULL));
    } else if (g_str_equal(name, "Event")) {
        event(args); g_dbus_method_invocation_return_value(call, NULL);
    } else if (g_str_equal(name, "EventGroup")) {
        g_autoptr(GVariant) events = g_variant_get_child_value(args, 0);
        GVariantIter iter; g_variant_iter_init(&iter, events); GVariant *one;
        while ((one = g_variant_iter_next_value(&iter))) { event(one); g_variant_unref(one); }
        g_dbus_method_invocation_return_value(call, g_variant_new("(ai)", NULL));
    }
}

static GVariant *property(GDBusConnection *connection, const char *sender, const char *path,
    const char *interface, const char *name, GError **error, gpointer data) {
    (void)connection; (void)sender; (void)path; (void)error; (void)data;
    if (g_str_equal(interface, "com.canonical.dbusmenu")) {
        if (g_str_equal(name, "Version")) return g_variant_new_uint32(3);
        if (g_str_equal(name, "TextDirection")) return g_variant_new_string("ltr");
        if (g_str_equal(name, "IconThemePath")) return g_variant_new_strv(NULL, 0);
        return g_variant_new_string("normal");
    }
    if (g_str_equal(name, "Menu")) return g_variant_new_object_path(menu_path);
    if (g_str_equal(name, "ItemIsMenu")) return g_variant_new_boolean(TRUE);
    if (g_str_equal(name, "WindowId")) return g_variant_new_int32(0);
    if (g_str_equal(name, "IconPixmap")) {
        /* Happy's existing H mark in network-order ARGB, sized to a standard 18px icon. */
        guint8 pixels[18 * 18 * 4] = {0};
        for (int y = 2; y < 16; y++) for (int x = 2; x < 16; x++) {
            int col = (x - 2) / 5, row = (y - 2) / 5;
            if ((x - 2) % 5 == 4 || (y - 2) % 5 == 4 || (col == 1 && row != 1)) continue;
            for (int channel = 0; channel < 4; channel++) pixels[(y * 18 + x) * 4 + channel] = 255;
        }
        GVariantBuilder icons; g_variant_builder_init(&icons, G_VARIANT_TYPE("a(iiay)"));
        g_variant_builder_add(&icons, "(ii@ay)", 18, 18, g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, pixels, sizeof(pixels), 1));
        return g_variant_builder_end(&icons);
    }
    if (g_str_equal(name, "Category")) return g_variant_new_string("SystemServices");
    if (g_str_equal(name, "Status")) return g_variant_new_string("Active");
    if (g_str_equal(name, "IconName")) return g_variant_new_string("");
    return g_variant_new_string(g_str_equal(name, "Id") ? "happy-agent" : "Happy");
}

static gboolean ended(gint fd, GIOCondition condition, gpointer data) {
    (void)fd; (void)condition; (void)data; g_main_loop_quit(loop); return G_SOURCE_REMOVE;
}

static gboolean terminated(gpointer data) {
    (void)data;
    g_main_loop_quit(loop);
    return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
    for (int i = 1; i + 1 < argc; i += 2) {
        if (g_str_equal(argv[i], "--socket")) socket_path = argv[i + 1];
        if (g_str_equal(argv[i], "--token-file")) token_path = argv[i + 1];
    }
    if (!socket_path || !token_path) return 2;
    if (!g_getenv("DBUS_SESSION_BUS_ADDRESS")) return 0;
    pid_t parent = getppid();
    if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent) return 0;
    g_autoptr(GError) error = NULL;
    bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!bus) return 0;
    g_autoptr(GVariant) owner = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "NameHasOwner", g_variant_new("(s)", watcher), G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NONE, 2000, NULL, NULL);
    gboolean available = FALSE;
    if (owner) g_variant_get(owner, "(b)", &available);
    if (!available) { g_object_unref(bus); return 0; }
    curl_global_init(CURL_GLOBAL_DEFAULT);
    headline = g_strdup("Happy Agent is running");
    g_autoptr(GDBusNodeInfo) info = g_dbus_node_info_new_for_xml(introspection, &error);
    static const GDBusInterfaceVTable vtable = { .method_call = method, .get_property = property };
    guint item = g_dbus_connection_register_object(bus, item_path, info->interfaces[0], &vtable, NULL, NULL, &error);
    guint menu = g_dbus_connection_register_object(bus, menu_path, info->interfaces[1], &vtable, NULL, NULL, &error);
    if (!item || !menu) { g_printerr("Happy tray: %s\n", error->message); return 1; }
    loop = g_main_loop_new(NULL, FALSE);
    g_unix_fd_add(STDIN_FILENO, G_IO_HUP | G_IO_ERR, ended, NULL);
    g_unix_signal_add(SIGTERM, terminated, NULL);
    g_dbus_connection_call(bus, watcher, "/StatusNotifierWatcher", watcher, "RegisterStatusNotifierItem",
        g_variant_new("(s)", item_path), NULL, G_DBUS_CALL_FLAGS_NONE, 2000, NULL, NULL, NULL);
    refresh();
    g_main_loop_run(loop);
    return 0;
}