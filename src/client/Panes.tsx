/**
 * 阅读器打不开的文件：显示「打开方式」控件。
 *
 * 用 `.doc`、`.pdf`、`.sql` 这类文件时，面板内没有渲染器可用 —— 与其报错，
 * 不如给一个明确的去处：列可用应用、用默认程序打开、或在文件管理器里定位。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NoteTab } from './store';
import { IconChevronDown } from './icons';
import { messageOf } from './paths';

// ---------------------------------------------------------------------------
// 不可预览文件
// ---------------------------------------------------------------------------

/** 与官方 ui-open-in-app 一致的文案（不自己另编，保证措辞统一）。 */
const EXTERNAL_LABELS = {
  /** 主按钮：用某个应用打开。 */
  openWith: (app: string): string => `用 ${app} 打开`,
  /** 无法判定默认应用时，主按钮退化为「显示文件位置」。 */
  reveal: '显示文件位置',
  /** 菜单里给默认项加的后缀。 */
  appDefault: (app: string): string => `${app}（默认）`,
  /** 应用列表读取失败的占位项。 */
  appsError: '无法获取应用列表',
  /** 一个可用应用都没有时的说明。 */
  noApps: '系统里没有找到能打开此格式的应用',
  /** 不支持交给桌面程序的平台说明。 */
  unsupported: '当前环境不支持用系统程序打开文件',
  /** 打开失败。 */
  openError: '打开失败，请重试',
  /** 显示位置失败。 */
  revealError: '无法显示文件位置，请重试',
} as const;

/** 不可预览页的属性。 */
export interface ExternalPaneProps {
  tab: NoteTab;
  openExternal: (
    path: string,
    options?: { application?: string; reveal?: boolean },
  ) => Promise<string | null>;
  canOpenExternal: () => Promise<boolean>;
  listApplications: (path: string) => Promise<
    readonly { id: string; name?: string; default?: boolean }[] | null
  >;
  onNotice: (message: string) => void;
}

/**
 * 阅读器打不开的文件（.doc/.pdf/.sql 等）的提示页。
 *
 * 交互：点树里的这类文件**不再直接弹出系统程序**，而是在这里显示
 * 「此格式无法在阅读器中打开」+ 一个原生风格的分裂按钮 —— 左边用默认应用打开、
 * 右边下拉列出系统里所有能打开它的应用，底部另有「显示文件位置」。
 * 接口与文案都对齐官方 ui-open-in-app（它也在 DSH 右侧栏做同样的事）。
 */
export function ExternalPane(props: ExternalPaneProps): JSX.Element {
  const { tab, openExternal, canOpenExternal, listApplications, onNotice } = props;
  const path = tab.path ?? '';

  /** null=探测中；false=该平台不支持交给桌面程序。 */
  const [desktop, setDesktop] = useState<boolean | null>(null);
  /** 应用列表；null=读取失败。 */
  const [apps, setApps] = useState<readonly { id: string; name?: string; default?: boolean }[] | null>(null);
  const [loadingApps, setLoadingApps] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 先问宿主能不能交给桌面程序；不能就不显示按钮，只给说明。
  useEffect(() => {
    let alive = true;
    void canOpenExternal().then((value) => {
      if (alive) setDesktop(value);
    });
    return () => {
      alive = false;
    };
  }, [canOpenExternal]);

  // 桌面可用时再拉应用列表（不可用时没必要拉）。
  useEffect(() => {
    if (desktop !== true || path === '') return undefined;
    let alive = true;
    setLoadingApps(true);
    void listApplications(path).then((value) => {
      if (!alive) return;
      setApps(value);
      setLoadingApps(false);
    });
    return () => {
      alive = false;
    };
  }, [desktop, path, listApplications]);

  /** 默认应用：优先标了 default 的，否则第一个。 */
  const preferred = useMemo(() => {
    if (apps === null || apps.length === 0) return null;
    return apps.find((app) => app.default === true) ?? apps[0];
  }, [apps]);

  /** 执行一次打开/显示位置，并处理失败提示。 */
  const act = useCallback(
    async (options?: { application?: string; reveal?: boolean }) => {
      if (path === '' || busy) return;
      setBusy(true);
      setMenuOpen(false);
      try {
        const failure = await openExternal(path, options);
        if (failure !== null) onNotice(failure);
      } catch (error) {
        onNotice(
          options?.reveal === true
            ? EXTERNAL_LABELS.revealError
            : `${EXTERNAL_LABELS.openError}（${messageOf(error)}）`,
        );
      } finally {
        setBusy(false);
      }
    },
    [path, busy, openExternal, onNotice],
  );

  /** 主按钮：有默认应用就用它打开，否则退化为「显示文件位置」。 */
  const runPrimary = useCallback(() => {
    if (preferred === null) void act({ reveal: true });
    else if (preferred.default === true) void act();
    else void act({ application: preferred.id });
  }, [preferred, act]);

  /** 菜单项：每个可用应用 + 底部的「显示文件位置」。 */
  const menuItems = useMemo(() => {
    const items: { id: string; label: string; disabled?: boolean }[] = [];
    if (apps !== null) {
      for (const app of apps) {
        const name = app.name ?? app.id;
        items.push({
          id: `app:${app.id}`,
          label: app.id === preferred?.id ? EXTERNAL_LABELS.appDefault(name) : name,
        });
      }
    } else if (!loadingApps) {
      items.push({ id: 'unavailable', label: EXTERNAL_LABELS.appsError, disabled: true });
    }
    return items;
  }, [apps, preferred, loadingApps]);

  const primaryLabel =
    preferred === null ? EXTERNAL_LABELS.reveal : EXTERNAL_LABELS.openWith(preferred.name ?? preferred.id);
  const hasMenu = loadingApps || apps === null || menuItems.length + 1 > 1;

  return (
    <div className="dsh-notes__external">
      <div className="dsh-notes__external-card">
        <div className="dsh-notes__external-glyph" aria-hidden="true">
          <FileTypeIcon path={tab.name} size={40} />
        </div>
        <h3 className="dsh-notes__external-title">{tab.name}</h3>
        <p className="dsh-notes__external-hint">此格式无法在阅读器中打开</p>

        {desktop === false ? (
          <p className="dsh-notes__external-note">{EXTERNAL_LABELS.unsupported}</p>
        ) : desktop === null ? null : (
          <div className="dsh-notes__external-actions">
            {/* 分裂按钮：左＝用默认应用打开，右＝下拉选其他应用 */}
            <div className="dsh-notes__openwith" data-busy={busy ? '' : undefined}>
              <button
                type="button"
                className="dsh-notes__openwith-main"
                disabled={busy}
                onClick={runPrimary}
                title={primaryLabel}
              >
                <span className="dsh-notes__openwith-icon" aria-hidden="true">
                  <FileTypeIcon path={tab.name} size={15} />
                </span>
                <span className="dsh-notes__openwith-label">{primaryLabel}</span>
              </button>
              <button
                type="button"
                className="dsh-notes__openwith-caret"
                disabled={busy || !hasMenu}
                aria-label="更多打开方式"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconChevronDown size={14} />
              </button>
            </div>

            {menuOpen && (
              <>
                <div
                  className="dsh-notes__menu-mask"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden="true"
                />
                <div className="dsh-notes__openwith-menu" role="menu">
                  {loadingApps ? (
                    <div className="dsh-notes__openwith-loading">正在读取应用列表…</div>
                  ) : (
                    <>
                      {menuItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="menuitem"
                          className="dsh-notes__openwith-item"
                          disabled={item.disabled === true}
                          onClick={() => {
                            if (item.id.startsWith('app:')) void act({ application: item.id.slice(4) });
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                      {apps !== null && apps.length === 0 && (
                        <div className="dsh-notes__openwith-loading">{EXTERNAL_LABELS.noApps}</div>
                      )}
                      <div className="dsh-notes__openwith-sep" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        className="dsh-notes__openwith-item"
                        onClick={() => void act({ reveal: true })}
                      >
                        {EXTERNAL_LABELS.reveal}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <p className="dsh-notes__external-path" title={path}>
          {path}
        </p>
      </div>
    </div>
  );
}

