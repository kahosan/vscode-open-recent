import { Action, ActionPanel, getPreferenceValues, Icon, Image, List, showToast, Toast } from "@raycast/api";
import { useSQL } from "@raycast/utils";
import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// App bundles can live in either of these directories.
const APP_DIRS = ["/Applications", join(homedir(), "Applications")];

type Build = { app: string; bundle: string; scheme: string };

// build (folder under ~/Library/Application Support) -> app name for `open -a`,
// app bundle (to find product.json) and URL scheme for remote entries
const BUILDS: Record<string, Build> = {
  Code: { app: "Visual Studio Code", bundle: "Visual Studio Code.app", scheme: "vscode" },
  "Code - Insiders": {
    app: "Visual Studio Code - Insiders",
    bundle: "Visual Studio Code - Insiders.app",
    scheme: "vscode-insiders",
  },
  Cursor: { app: "Cursor", bundle: "Cursor.app", scheme: "cursor" },
  VSCodium: { app: "VSCodium", bundle: "VSCodium.app", scheme: "vscode-oss" },
  Windsurf: { app: "Windsurf", bundle: "Windsurf.app", scheme: "windsurf" },
};

const build = getPreferenceValues<Preferences>().build || "Code";
const { app: appName, bundle, scheme } = BUILDS[build] ?? BUILDS.Code;

function findInAppDirs(...segments: string[]): string | undefined {
  return APP_DIRS.map((dir) => join(dir, ...segments)).find((candidate) => existsSync(candidate));
}

const appPath = findInAppDirs(bundle);
const appIcon: Image.ImageLike = appPath ? { fileIcon: appPath } : Icon.Code;
const globalStorageDir = join(homedir(), "Library", "Application Support", build, "User", "globalStorage");

// Newer builds keep the recent list in a shared DB: ~/<sharedDataFolderName>/sharedStorage/state.vscdb
// (folder name comes from the app's product.json). Same lookup order as the original extension.
function getSharedDbPath(): string | undefined {
  const productJson = findInAppDirs(bundle, "Contents", "Resources", "app", "product.json");
  if (!productJson) return undefined;
  try {
    const { sharedDataFolderName } = JSON.parse(readFileSync(productJson, "utf-8")) as {
      sharedDataFolderName?: string;
    };
    return sharedDataFolderName ? join(homedir(), sharedDataFolderName, "sharedStorage", "state.vscdb") : undefined;
  } catch {
    return undefined;
  }
}

function getDbPath(): string {
  const shared = getSharedDbPath();
  return shared && existsSync(shared) ? shared : join(globalStorageDir, "state.vscdb");
}

const dbPath = getDbPath();

type Row = { entries: string };

type Entry = {
  folderUri?: string;
  fileUri?: string;
  workspace?: { configPath: string };
  remoteAuthority?: string;
  label?: string;
};

type Kind = "folder" | "workspace" | "file";

type ItemBase = {
  uri: string;
  kind: Kind;
  title: string;
  subtitle: string;
  keywords: string[];
  icon: Image.ImageLike;
};

type LocalItem = ItemBase & { remote: false; localPath: string };
type RemoteItem = ItemBase & { remote: true; tag: string };
type Item = LocalItem | RemoteItem;

// Same key the original extension reads (older builds used history.recentlyOpenedPathsList).
const QUERY = `
  SELECT json_extract(value, '$.entries') AS entries
  FROM ItemTable
  WHERE key IN ('recently.opened', 'history.recentlyOpenedPathsList')
  ORDER BY CASE key WHEN 'recently.opened' THEN 0 ELSE 1 END
  LIMIT 1
`;

function formatAuthority(authority: string): string {
  if (authority.startsWith("ssh-remote+")) return `SSH: ${authority.slice("ssh-remote+".length)}`;
  if (authority.startsWith("wsl+")) return `WSL: ${authority.slice(4)}`;
  if (authority.startsWith("dev-container+")) return "Dev Container";
  if (authority.startsWith("attached-container+")) return "Container";
  if (authority.startsWith("codespaces+")) return "Codespaces";
  return authority;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseEntries(rows: Row[]): Entry[] {
  if (!rows[0]?.entries) return [];
  try {
    return JSON.parse(rows[0].entries) as Entry[];
  } catch {
    return [];
  }
}

function toLocalItem(uri: string, kind: Kind): LocalItem | undefined {
  // `fileURLToPath` already decodes the URI, so `basename` is the real folder name.
  const path = fileURLToPath(uri);
  if (!existsSync(path)) return undefined; // project was deleted or moved
  return {
    uri,
    kind,
    remote: false,
    icon: { fileIcon: path },
    title: basename(path),
    subtitle: dirname(path).replace(homedir(), "~"),
    keywords: path.split("/").filter(Boolean),
    localPath: path,
  };
}

function toRemoteItem(uri: string, kind: Kind, entry: Entry): RemoteItem {
  const authority = entry.remoteAuthority ?? safeDecode(new URL(uri).host);
  let remotePath = "/";
  try {
    remotePath = safeDecode(new URL(uri).pathname);
  } catch {
    /* keep "/" */
  }
  return {
    uri,
    kind,
    remote: true,
    icon: Icon.Folder,
    title: basename(remotePath) || remotePath,
    subtitle: dirname(remotePath),
    tag: formatAuthority(authority),
    keywords: [
      ...authority.split("+"),
      ...remotePath.split("/").filter(Boolean),
      ...(entry.label ? [entry.label] : []),
    ],
  };
}

function toItems(rows: Row[] | undefined): Item[] {
  if (!rows) return []; // undefined while useSQL is still loading
  const items: Item[] = [];
  const seen = new Set<string>();

  for (const entry of parseEntries(rows)) {
    const uri = entry.folderUri ?? entry.workspace?.configPath ?? entry.fileUri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const kind: Kind = entry.folderUri ? "folder" : entry.workspace ? "workspace" : "file";

    if (uri.startsWith("file://")) {
      const item = toLocalItem(uri, kind);
      if (item) items.push(item);
    } else if (uri.startsWith("vscode-remote://")) {
      items.push(toRemoteItem(uri, kind, entry));
    }
    // other schemes (vscode-vfs://, etc.) are skipped
  }
  return items;
}

async function runOpen(args: string[]) {
  try {
    await execFileAsync("/usr/bin/open", args);
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to open project",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function openLocal(path: string, newWindow = false) {
  return runOpen(["-a", appName, ...(newWindow ? ["-n"] : []), path]);
}

// Same approach as the original extension on macOS:
// vscode-remote://... -> <scheme>://vscode-remote/..., windowId=_blank forces a new window.
function openRemote(uri: string, newWindow: boolean) {
  const url = new URL(uri.replace("vscode-remote://", `${scheme}://vscode-remote/`));
  if (newWindow) url.searchParams.set("windowId", "_blank");
  else url.searchParams.delete("windowId");
  return runOpen([url.toString()]);
}

export default function Command() {
  const { data, isLoading, permissionView } = useSQL<Row>(dbPath, QUERY);
  if (permissionView) return permissionView;

  const items = toItems(data);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search recent projects...">
      {!isLoading && items.length === 0 ? (
        <List.EmptyView title="No recent projects" description={`Nothing found in ${dbPath}`} />
      ) : null}
      {items.map((item) => (
        <List.Item
          key={item.uri}
          title={item.title}
          subtitle={item.subtitle}
          icon={item.icon}
          accessories={item.remote ? [{ tag: item.tag }] : []}
          keywords={item.keywords}
          actions={
            <ActionPanel>
              {item.remote ? (
                <>
                  <Action
                    title={`Open in ${appName}`}
                    icon="action-icon.png"
                    onAction={() => openRemote(item.uri, false)}
                  />
                  <Action
                    title="Open in New Window"
                    icon={Icon.NewDocument}
                    shortcut={{ modifiers: ["cmd"], key: "n" }}
                    onAction={() => openRemote(item.uri, true)}
                  />
                </>
              ) : (
                <>
                  <Action title={`Open in ${appName}`} icon={appIcon} onAction={() => openLocal(item.localPath)} />
                  <Action
                    title="Open in New Window"
                    icon={Icon.NewDocument}
                    shortcut={{ modifiers: ["cmd"], key: "n" }}
                    onAction={() => openLocal(item.localPath, true)}
                  />
                  <Action.ShowInFinder path={item.localPath} shortcut={{ modifiers: ["cmd"], key: "f" }} />
                </>
              )}
              <Action.CopyToClipboard
                title={item.remote ? "Copy URI" : "Copy Path"}
                content={item.remote ? item.uri : item.localPath}
                shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
