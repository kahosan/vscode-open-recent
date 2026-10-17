import type { Image } from '@raycast/api';

import { homedir } from 'os';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';

import { z } from 'zod/mini';
import { useSQL } from '@raycast/utils';
import { extractErrorMessage } from 'foxts/extract-error-message';
import {
  Action,
  ActionPanel,
  closeMainWindow,
  getPreferenceValues,
  Icon,
  List,
  showToast,
  Toast
} from '@raycast/api';

const execFileAsync = promisify(execFile);

const HOME = homedir();

// App bundles can live in either of these directories.
const APP_DIRS = ['/Applications', join(HOME, 'Applications')];

interface EditorBuild { app: string, bundle: string, scheme: string }

// build (folder under ~/Library/Application Support) -> app name for `open -a`,
// app bundle (to find product.json) and URL scheme for remote entries
const EDITOR_BUILDS: Record<string, EditorBuild> = {
  Code: { app: 'Visual Studio Code', bundle: 'Visual Studio Code.app', scheme: 'vscode' },
  'Code - Insiders': {
    app: 'Visual Studio Code - Insiders',
    bundle: 'Visual Studio Code - Insiders.app',
    scheme: 'vscode-insiders'
  },
  Cursor: { app: 'Cursor', bundle: 'Cursor.app', scheme: 'cursor' },
  VSCodium: { app: 'VSCodium', bundle: 'VSCodium.app', scheme: 'vscode-oss' },
  Windsurf: { app: 'Windsurf', bundle: 'Windsurf.app', scheme: 'windsurf' }
};

const { build } = getPreferenceValues<Preferences>();
const { app: appName, bundle, scheme } = EDITOR_BUILDS[build] ?? EDITOR_BUILDS.Code;

function locateInAppDirs(...segments: string[]): string | undefined {
  return APP_DIRS.map(dir => join(dir, ...segments)).find(candidate => existsSync(candidate));
}

function withHomeAbbreviated(path: string): string {
  return path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}

const appPath = locateInAppDirs(bundle);
const appIcon: Image.ImageLike = appPath ? { fileIcon: appPath } : Icon.Code;
const globalStorageDir = join(HOME, 'Library', 'Application Support', build, 'User', 'globalStorage');

// Newer builds keep the recent list in a shared DB: ~/<sharedDataFolderName>/sharedStorage/state.vscdb
// (folder name comes from the app's product.json). Same lookup order as the original extension.
function resolveDBPath(): string {
  const productJson = locateInAppDirs(bundle, 'Contents', 'Resources', 'app', 'product.json');
  if (productJson) {
    try {
      const { sharedDataFolderName } = JSON.parse(readFileSync(productJson, 'utf-8')) as {
        sharedDataFolderName?: string
      };
      if (sharedDataFolderName) {
        const shared = join(HOME, sharedDataFolderName, 'sharedStorage', 'state.vscdb');
        if (existsSync(shared)) return shared;
      }
    } catch {
      /* fall back to the per-user global storage DB */
    }
  }
  return join(globalStorageDir, 'state.vscdb');
}

const DB_PATH = resolveDBPath();

interface RecentRow { entries: string | null }

// The history blob is written by the editor, not by us, so validate it rather than casting:
// `looseObject` keeps whatever extra fields a given build adds.
const WorkspaceSchema = z.looseObject({
  configPath: z.optional(z.string())
});

const RecentEntrySchema = z.looseObject({
  folderUri: z.optional(z.string()),
  fileUri: z.optional(z.string()),
  workspace: z.optional(WorkspaceSchema),
  remoteAuthority: z.optional(z.string()),
  label: z.optional(z.string())
});

type RecentEntry = z.infer<typeof RecentEntrySchema>;

type EntryKind = 'folder' | 'workspace' | 'file';

interface RecentItemBase {
  uri: string
  kind: EntryKind
  title: string
  subtitle: string
  keywords: string[]
  icon: Image.ImageLike
}

type RecentTarget = 'local' | 'remote';

interface LocalRecentItem extends RecentItemBase {
  target: Extract<RecentTarget, 'local'>
  localPath: string
}

interface RemoteRecentItem extends RecentItemBase {
  target: Extract<RecentTarget, 'remote'>
  tag: string
}

type RecentItem = LocalRecentItem | RemoteRecentItem;

// Same key the original extension reads (older builds used history.recentlyOpenedPathsList).
const QUERY = `
  SELECT json_extract(value, '$.entries') AS entries
  FROM ItemTable
  WHERE key IN ('recently.opened', 'history.recentlyOpenedPathsList')
  ORDER BY CASE key WHEN 'recently.opened' THEN 0 ELSE 1 END
  LIMIT 1
`;

function describeAuthority(authority: string): string {
  if (authority.startsWith('ssh-remote+')) return `SSH: ${authority.slice('ssh-remote+'.length)}`;
  if (authority.startsWith('wsl+')) return `WSL: ${authority.slice(4)}`;
  if (authority.startsWith('dev-container+')) return 'Dev Container';
  if (authority.startsWith('attached-container+')) return 'Container';
  if (authority.startsWith('codespaces+')) return 'Codespaces';
  return authority;
}

// A single entry from the history blob -> a list item, or undefined when we can't open it
// (no URI, removed project, unparsable URI, scheme we don't handle).
function buildItem(entry: RecentEntry): RecentItem | undefined {
  const uri = entry.folderUri ?? entry.workspace?.configPath ?? entry.fileUri;
  if (!uri) return;

  const kind: EntryKind = entry.folderUri ? 'folder' : (entry.workspace ? 'workspace' : 'file');

  if (uri.startsWith('file://')) {
    const path = fileURLToPath(uri);
    if (!existsSync(path)) return; // project was deleted or moved

    return {
      uri,
      kind,
      target: 'local',
      icon: { fileIcon: path },
      title: basename(path),
      subtitle: withHomeAbbreviated(dirname(path)),
      keywords: path.split('/').filter(Boolean),
      localPath: path
    };
  }

  if (uri.startsWith('vscode-remote://')) {
    const url = new URL(uri);
    const authority = entry.remoteAuthority ?? decodeURIComponent(url.host);
    const remotePath = decodeURIComponent(url.pathname) || '/';

    return {
      uri,
      kind,
      target: 'remote',
      icon: Icon.Folder,
      title: basename(remotePath) || remotePath,
      subtitle: dirname(remotePath),
      tag: describeAuthority(authority),
      keywords: [
        ...authority.split('+'),
        ...remotePath.split('/').filter(Boolean),
        ...(entry.label ? [entry.label] : [])
      ]
    };
  }
}

// Reads the JSON blob `useSQL` handed back and turns every entry we can open into a list item.
function parseRecentItems(rows: RecentRow[] | undefined): RecentItem[] {
  if (!rows) return []; // undefined while useSQL is still loading

  let decoded: unknown;
  try {
    decoded = JSON.parse(rows.at(0)?.entries ?? '');
  } catch {
    return []; // malformed history
  }
  if (!Array.isArray(decoded)) return [];

  const items: RecentItem[] = [];
  const seen = new Set<string>();

  // Entries are validated and built one at a time on purpose: a single entry the editor wrote in
  // a shape we don't expect shouldn't take the whole list down with it.
  for (const candidate of decoded) {
    const { data: entry, success } = z.safeParse(RecentEntrySchema, candidate);
    if (!success) continue;

    let item: RecentItem | undefined;
    try {
      item = buildItem(entry);
    } catch {
      continue; // unparsable URI for an entry that passed the schema
    }
    if (!item || seen.has(item.uri)) continue;

    seen.add(item.uri);
    items.push(item);
  }
  return items;
}

async function execOpen(args: string[]) {
  try {
    await execFileAsync('/usr/bin/open', args);
    return true;
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to open project',
      message: extractErrorMessage(error, false) ?? 'Unknown error'
    });
    return false;
  }
}

async function openLocalPath(path: string, newWindow = false) {
  const opened = await execOpen(['-a', appName, ...(newWindow ? ['-n'] : []), path]);
  if (opened) await closeMainWindow();
}

// Same approach as the original extension on macOS:
// vscode-remote://... -> <scheme>://vscode-remote/..., windowId=_blank forces a new window.
async function openRemoteUri(uri: string, newWindow: boolean) {
  const url = new URL(uri.replace('vscode-remote://', `${scheme}://vscode-remote/`));
  if (newWindow) url.searchParams.set('windowId', '_blank');
  else url.searchParams.delete('windowId');
  const opened = await execOpen([url.href]);
  if (opened) await closeMainWindow();
}

export default function Command() {
  const { data, isLoading, error, permissionView } = useSQL<RecentRow>(DB_PATH, QUERY);
  if (permissionView) return permissionView;

  const items = parseRecentItems(data);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search recent projects...">
      {!isLoading && items.length === 0 ? (
        <List.EmptyView
          title={error ? 'Could not read recent projects' : 'No recent projects'}
          description={
            error ? (extractErrorMessage(error) ?? 'Unknown error') : `Nothing found in ${DB_PATH}`
          }
        />
      ) : null}
      {items.map(item => (
        <List.Item
          key={item.uri}
          title={item.title}
          subtitle={item.subtitle}
          icon={item.icon}
          accessories={item.target === 'remote' ? [{ tag: item.tag }] : []}
          keywords={item.keywords}
          actions={
            <ActionPanel>
              {item.target === 'remote' ? (
                <>
                  <Action
                    title={`Open in ${appName}`}
                    icon="action-icon.png"
                    onAction={() => openRemoteUri(item.uri, false)}
                  />
                  <Action
                    title="Open in New Window"
                    icon={Icon.NewDocument}
                    shortcut={{ modifiers: ['cmd'], key: 'n' }}
                    onAction={() => openRemoteUri(item.uri, true)}
                  />
                </>
              ) : (
                <>
                  <Action
                    title={`Open in ${appName}`}
                    icon={appIcon}
                    onAction={() => openLocalPath(item.localPath)}
                  />
                  <Action
                    title="Open in New Window"
                    icon={Icon.NewDocument}
                    shortcut={{ modifiers: ['cmd'], key: 'n' }}
                    onAction={() => openLocalPath(item.localPath, true)}
                  />
                  <Action.ShowInFinder path={item.localPath} shortcut={{ modifiers: ['cmd'], key: 'f' }} />
                </>
              )}
              <Action.CopyToClipboard
                title={item.target === 'remote' ? 'Copy URI' : 'Copy Path'}
                content={item.target === 'remote' ? item.uri : item.localPath}
                shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
