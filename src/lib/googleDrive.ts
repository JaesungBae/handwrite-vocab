const DRIVE_API = "https://www.googleapis.com/drive/v3";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VocabEntry {
  word: string;
  meanings: { partOfSpeech: string; definitions: { definition: string; example?: string }[] }[];
  lang: string;
  addedAt: string;
}

export interface ProjectMeta {
  folderId: string;
  name: string;
  description: string;
  createdAt: string;
  wordCount: number;
}

interface VocabFile {
  project: string;
  entries: VocabEntry[];
}

// ── Session cache (invalidated when access token changes) ─────────────────────

const _s = {
  token: "",
  folders: new Map<string, string>(),
  vocabFiles: new Map<string, { id: string; data: VocabFile }>(),
  projectsFileId: "",
  projects: [] as ProjectMeta[],
  projectsLoaded: false,
};

function sess(accessToken: string) {
  if (_s.token !== accessToken) {
    _s.token = accessToken;
    _s.folders.clear();
    _s.vocabFiles.clear();
    _s.projectsFileId = "";
    _s.projects = [];
    _s.projectsLoaded = false;
  }
  return _s;
}

// ── Low-level Drive helpers ────────────────────────────────────────────────────

async function searchFile(
  q: string,
  accessToken: string
): Promise<string | null> {
  try {
    const r = await fetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) return null;
    const { files } = await r.json();
    return files?.length > 0 ? files[0].id : null;
  } catch {
    return null;
  }
}

async function downloadJson<T>(fileId: string, accessToken: string): Promise<T | null> {
  try {
    const r = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

async function uploadJson(
  content: unknown,
  name: string,
  parentId: string,
  accessToken: string
): Promise<string> {
  const boundary = "b_" + Date.now().toString(36);
  const metadata = JSON.stringify({ name, mimeType: "application/json", parents: [parentId] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(content),
    `\r\n--${boundary}--`,
  ]);
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!r.ok) throw new Error(`Upload failed (${r.status})`);
  return (await r.json()).id;
}

async function patchJson(fileId: string, content: unknown, accessToken: string): Promise<void> {
  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(content, null, 2),
  });
}

// ── Folder management ──────────────────────────────────────────────────────────

async function getOrCreateFolder(
  name: string,
  parentId: string | null,
  accessToken: string
): Promise<string> {
  const s = sess(accessToken);
  const key = `${parentId ?? "root"}/${name}`;
  if (s.folders.has(key)) return s.folders.get(key)!;

  const lsCached = localStorage.getItem(`hv:folder:${key}`);
  if (lsCached) { s.folders.set(key, lsCached); return lsCached; }

  const q = [
    `name='${name}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
    parentId ? `'${parentId}' in parents` : `'root' in parents`,
  ].join(" and ");

  const found = await searchFile(q, accessToken);
  if (found) {
    s.folders.set(key, found);
    localStorage.setItem(`hv:folder:${key}`, found);
    return found;
  }

  const r = await fetch(`${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!r.ok) throw new Error(`Folder creation failed (${r.status})`);
  const { id } = await r.json();
  s.folders.set(key, id);
  localStorage.setItem(`hv:folder:${key}`, id);
  return id;
}

// ── Projects file ──────────────────────────────────────────────────────────────

async function loadProjectsFile(rootId: string, accessToken: string): Promise<void> {
  const s = sess(accessToken);
  if (s.projectsLoaded) return;

  const lsKey = `hv:projectsFile:${rootId}`;
  let fileId = localStorage.getItem(lsKey) ?? "";

  if (!fileId) {
    fileId =
      (await searchFile(
        `name='projects.json' and '${rootId}' in parents and trashed=false`,
        accessToken
      )) ?? "";
    if (fileId) localStorage.setItem(lsKey, fileId);
  }

  if (fileId) {
    const data = await downloadJson<{ projects: ProjectMeta[] }>(fileId, accessToken);
    if (data) {
      s.projectsFileId = fileId;
      s.projects = data.projects ?? [];
      s.projectsLoaded = true;
      return;
    }
  }

  fileId = await uploadJson({ projects: [] }, "projects.json", rootId, accessToken);
  localStorage.setItem(lsKey, fileId);
  s.projectsFileId = fileId;
  s.projects = [];
  s.projectsLoaded = true;
}

function flushProjects(accessToken: string): void {
  const s = sess(accessToken);
  if (s.projectsFileId) {
    patchJson(s.projectsFileId, { projects: s.projects }, accessToken);
  }
}

async function renameFolder(folderId: string, newName: string, accessToken: string): Promise<void> {
  await fetch(`${DRIVE_API}/files/${folderId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function listProjects(accessToken: string): Promise<ProjectMeta[]> {
  const rootId = await getOrCreateFolder("Drawwords", null, accessToken);
  await loadProjectsFile(rootId, accessToken);
  return sess(accessToken).projects;
}

export async function createProject(
  name: string,
  description: string,
  accessToken: string
): Promise<ProjectMeta> {
  const rootId = await getOrCreateFolder("Drawwords", null, accessToken);
  await loadProjectsFile(rootId, accessToken);
  const folderId = await getOrCreateFolder(name, rootId, accessToken);

  const project: ProjectMeta = {
    folderId,
    name,
    description,
    createdAt: new Date().toISOString(),
    wordCount: 0,
  };
  sess(accessToken).projects.push(project);
  flushProjects(accessToken);
  return project;
}

export async function saveWordEntry(
  entry: VocabEntry,
  accessToken: string,
  project: ProjectMeta
): Promise<void> {
  const s = sess(accessToken);

  // Load or init vocab cache for this project
  let cached = s.vocabFiles.get(project.folderId);
  if (!cached) {
    const lsKey = `hv:vocabFile:${project.folderId}`;
    let fileId = localStorage.getItem(lsKey) ?? "";

    if (!fileId) {
      fileId =
        (await searchFile(
          `name='vocab.json' and '${project.folderId}' in parents and trashed=false`,
          accessToken
        )) ?? "";
      if (fileId) localStorage.setItem(lsKey, fileId);
    }

    let data: VocabFile = { project: project.name, entries: [] };
    if (fileId) {
      data = (await downloadJson<VocabFile>(fileId, accessToken)) ?? data;
    } else {
      fileId = await uploadJson(data, "vocab.json", project.folderId, accessToken);
      localStorage.setItem(lsKey, fileId);
    }

    cached = { id: fileId, data };
    s.vocabFiles.set(project.folderId, cached);
  }

  const idx = cached.data.entries.findIndex(
    (e) => e.word.toLowerCase() === entry.word.toLowerCase()
  );
  const isNew = idx < 0;
  if (isNew) cached.data.entries.push(entry);
  else cached.data.entries[idx] = entry;

  if (isNew) {
    const meta = s.projects.find((p) => p.folderId === project.folderId);
    if (meta) { meta.wordCount++; project.wordCount = meta.wordCount; }
    flushProjects(accessToken);
  }

  await patchJson(cached.id, cached.data, accessToken);
}

export async function loadVocabEntries(
  project: ProjectMeta,
  accessToken: string
): Promise<VocabEntry[]> {
  const s = sess(accessToken);
  const cached = s.vocabFiles.get(project.folderId);
  if (cached) return cached.data.entries;

  const lsKey = `hv:vocabFile:${project.folderId}`;
  let fileId = localStorage.getItem(lsKey) ?? "";
  if (!fileId) {
    fileId =
      (await searchFile(
        `name='vocab.json' and '${project.folderId}' in parents and trashed=false`,
        accessToken
      )) ?? "";
    if (fileId) localStorage.setItem(lsKey, fileId);
  }
  if (!fileId) return [];
  const data = await downloadJson<VocabFile>(fileId, accessToken);
  return data?.entries ?? [];
}

export async function deleteProject(
  project: ProjectMeta,
  accessToken: string
): Promise<void> {
  const s = sess(accessToken);
  s.projects = s.projects.filter((p) => p.folderId !== project.folderId);
  s.vocabFiles.delete(project.folderId);
  // Remove localStorage caches for this project
  localStorage.removeItem(`hv:vocabFile:${project.folderId}`);
  flushProjects(accessToken);
  await fetch(`${DRIVE_API}/files/${project.folderId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}

export async function moveProject(
  folderId: string,
  direction: "up" | "down",
  accessToken: string
): Promise<void> {
  const s = sess(accessToken);
  const idx = s.projects.findIndex((p) => p.folderId === folderId);
  if (idx < 0) return;
  const newIdx = direction === "up" ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= s.projects.length) return;
  [s.projects[idx], s.projects[newIdx]] = [s.projects[newIdx], s.projects[idx]];
  flushProjects(accessToken);
}

export async function renameProject(
  folderId: string,
  newName: string,
  accessToken: string
): Promise<void> {
  const s = sess(accessToken);
  const meta = s.projects.find((p) => p.folderId === folderId);
  if (!meta) return;
  meta.name = newName;
  flushProjects(accessToken);
  await renameFolder(folderId, newName, accessToken);
}

export async function deleteWordEntry(
  word: string,
  accessToken: string,
  project: ProjectMeta
): Promise<void> {
  const s = sess(accessToken);
  const cached = s.vocabFiles.get(project.folderId);
  if (!cached) return;

  const idx = cached.data.entries.findIndex(
    (e) => e.word.toLowerCase() === word.toLowerCase()
  );
  if (idx < 0) return;

  cached.data.entries.splice(idx, 1);
  const meta = s.projects.find((p) => p.folderId === project.folderId);
  if (meta) { meta.wordCount = Math.max(0, meta.wordCount - 1); project.wordCount = meta.wordCount; }
  flushProjects(accessToken);
  await patchJson(cached.id, cached.data, accessToken);
}
