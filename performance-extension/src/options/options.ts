export {};

interface AllowedScope {
  origin: string;
  urlPatterns: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
}

function normalizeUrlPattern(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

async function fetchAllowedScopes(): Promise<AllowedScope[]> {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'GET_ALLOWED_SCOPES' });
    const raw = isRecord(resp) ? resp.scopes : null;
    if (!Array.isArray(raw)) {
      return [];
    }
    const scopes: AllowedScope[] = [];
    for (const item of raw) {
      if (!isRecord(item)) {
        continue;
      }
      const origin = normalizeOrigin(item.origin);
      const urlPatterns = Array.isArray(item.urlPatterns)
        ? item.urlPatterns.map((p) => normalizeUrlPattern(p)).filter((p) => p.length > 0)
        : ([] as string[]);
      if (!origin) {
        continue;
      }
      scopes.push({ origin, urlPatterns });
    }
    return scopes.sort((a, b) => a.origin.localeCompare(b.origin));
  } catch {
    return [];
  }
}

async function saveAllowedScopes(scopes: AllowedScope[]): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'SET_ALLOWED_SCOPES', payload: { scopes } });
    return isRecord(res) && res.ok === true;
  } catch {
    return false;
  }
}

async function requestOriginPermission(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

async function removeOriginPermission(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

function render(root: HTMLElement, scopes: AllowedScope[], onRefresh: () => void): void {
  root.innerHTML = '';

  const addSection = document.createElement('section');
  const addTitle = document.createElement('h2');
  addTitle.textContent = 'Domains';
  addSection.append(addTitle);

  const addRow = document.createElement('div');
  addRow.style.display = 'flex';
  addRow.style.gap = '8px';
  addRow.style.flexWrap = 'wrap';

  const originInput = document.createElement('input');
  originInput.type = 'text';
  originInput.placeholder = 'https://example.com';
  originInput.style.minWidth = '280px';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add Domain';

  addRow.append(originInput, addBtn);
  addSection.append(addRow);
  root.append(addSection);

  const listSection = document.createElement('section');
  const listTitle = document.createElement('h2');
  listTitle.textContent = 'Allowed Scopes';
  listSection.append(listTitle);

  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '12px';

  for (const scope of scopes) {
    const card = document.createElement('div');
    card.style.border = '1px solid rgba(0,0,0,0.12)';
    card.style.borderRadius = '8px';
    card.style.padding = '12px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.gap = '8px';

    const originLabel = document.createElement('div');
    originLabel.textContent = scope.origin;
    originLabel.style.fontWeight = '600';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Remove Domain';

    header.append(originLabel, deleteBtn);
    card.append(header);

    const patternsTitle = document.createElement('div');
    patternsTitle.textContent = 'Exact URL path patterns (optional)';
    patternsTitle.style.marginTop = '8px';
    card.append(patternsTitle);

    const patternsList = document.createElement('ul');
    patternsList.style.margin = '8px 0 0 16px';

    const patterns = Array.isArray(scope.urlPatterns) ? scope.urlPatterns : ([] as string[]);
    if (patterns.length === 0) {
      const li = document.createElement('li');
      li.textContent = '(none)';
      patternsList.append(li);
    } else {
      for (const p of patterns) {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.gap = '8px';
        li.style.alignItems = 'center';

        const span = document.createElement('span');
        span.textContent = p;

        const removePatternBtn = document.createElement('button');
        removePatternBtn.type = 'button';
        removePatternBtn.textContent = 'Remove';

        removePatternBtn.addEventListener('click', () => {
          void (async (): Promise<void> => {
            const nextScopes = scopes.map((s) => {
              if (s.origin !== scope.origin) {
                return s;
              }
              return { ...s, urlPatterns: s.urlPatterns.filter((x) => x !== p) };
            });
            const ok = await saveAllowedScopes(nextScopes);
            if (ok) {
              onRefresh();
            }
          })();
        });

        li.append(span, removePatternBtn);
        patternsList.append(li);
      }
    }

    card.append(patternsList);

    const addPatternRow = document.createElement('div');
    addPatternRow.style.display = 'flex';
    addPatternRow.style.gap = '8px';
    addPatternRow.style.marginTop = '8px';
    addPatternRow.style.flexWrap = 'wrap';

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.placeholder = '/checkout';
    patternInput.style.minWidth = '220px';

    const addPatternBtn = document.createElement('button');
    addPatternBtn.type = 'button';
    addPatternBtn.textContent = 'Add Pattern';

    addPatternRow.append(patternInput, addPatternBtn);
    card.append(addPatternRow);

    addPatternBtn.addEventListener('click', () => {
      const normalized = normalizeUrlPattern(patternInput.value);
      if (!normalized) {
        return;
      }
      void (async (): Promise<void> => {
        const nextScopes = scopes.map((s) => {
          if (s.origin !== scope.origin) {
            return s;
          }
          const set = new Set<string>(s.urlPatterns.map((x) => normalizeUrlPattern(x)).filter((x) => x.length > 0));
          set.add(normalized);
          return { ...s, urlPatterns: Array.from(set.values()).sort() };
        });
        const ok = await saveAllowedScopes(nextScopes);
        if (ok) {
          onRefresh();
        }
      })();
    });

    deleteBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        if (scopes.length <= 1) {
          return;
        }
        const confirmed = window.confirm(`Remove domain ${scope.origin}? This will also remove its permission.`);
        if (!confirmed) {
          return;
        }
        const nextScopes = scopes.filter((s) => s.origin !== scope.origin);
        const ok = await saveAllowedScopes(nextScopes);
        if (ok) {
          await removeOriginPermission(scope.origin);
          onRefresh();
        }
      })();
    });

    list.append(card);
  }

  listSection.append(list);
  root.append(listSection);

  addBtn.addEventListener('click', () => {
    const origin = normalizeOrigin(originInput.value);
    if (!origin) {
      return;
    }
    void (async (): Promise<void> => {
      const exists = scopes.some((s) => s.origin === origin);
      if (exists) {
        return;
      }
      const granted = await requestOriginPermission(origin);
      if (!granted) {
        return;
      }
      const nextScopes: AllowedScope[] = [...scopes, { origin, urlPatterns: [] as string[] }].sort((a, b) => a.origin.localeCompare(b.origin));
      const ok = await saveAllowedScopes(nextScopes);
      if (ok) {
        onRefresh();
      }
    })();
  });
}

async function init(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const refresh = (): void => {
    void (async (): Promise<void> => {
      const scopes = await fetchAllowedScopes();
      render(root, scopes, refresh);
    })();
  };

  refresh();
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
