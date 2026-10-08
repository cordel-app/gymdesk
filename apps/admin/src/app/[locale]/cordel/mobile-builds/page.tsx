'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { primaryBtnSmall, cardSurfaceStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listNameBadgeStyle, listScrollerClass,
} from '@/components/listChrome';
import {
  type MobileBuild, type MobileBuildsResponse, downloadPath, environmentLabelKey, formatBuildVersion,
  formatBytes, platformLabelKey, saveBlob, shortSha, showsAndroidInstallHelp, testflightHref,
} from '@/lib/mobileBuilds';

/**
 * #1077 — Cordel → Mobile builds: the test builds CI published, newest first, each
 * with a Download button.
 *
 * Read-only on purpose. `.github/workflows/mobile-build.yml` is the only writer and
 * the bucket is the record (`api/src/domain/mobileBuilds.ts`), so this page has no
 * upload, edit or delete: a build leaves the list when the workflow's retention
 * removes it. What a build is called, how it is formatted and which sentence a
 * platform needs live in `lib/mobileBuilds.ts`.
 */

interface ListColumn extends ListGridColumn {
  labelKey?: string;
  width: number;
  grow?: number;
}

// The identity (app, version, build) is the row's name on a phone. The widths are the
// smallest that still read, so that with the sidebar open the Download button is not
// pushed off the right edge of a narrow pane (the list scrolls below that, #1011).
const LIST_COLUMNS: ListColumn[] = [
  { key: 'build', labelKey: 'col_build', width: 140, grow: 3, mobile: 'name' },
  { key: 'platform', labelKey: 'col_platform', width: 72, grow: 1, mobile: 'secondary' },
  { key: 'built', labelKey: 'col_built', width: 104, grow: 1, mobile: 'secondary' },
  { key: 'size', labelKey: 'col_size', width: 64, mobile: 'secondary' },
  { key: 'actions', width: 96, mobile: 'actions' },
];

const CELL_CLASS = listCellClasses(LIST_COLUMNS);
const COLUMN_GAP = 8;
const ROW_PADDING_X = 12;
const GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');
const MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0) + COLUMN_GAP * (LIST_COLUMNS.length - 1) + ROW_PADDING_X * 2;

export default function CordelMobileBuildsPage() {
  const t = useTranslations('mobile_builds');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch, pdfFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();

  const [data, setData] = useState<MobileBuildsResponse | null>(null);
  const [loadError, setLoadError] = useState<'storage' | 'generic' | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (gymLoading || !isSuperadmin) return;
    (async () => {
      try {
        setData((await apiFetch('/platform/mobile-builds')) as MobileBuildsResponse);
      } catch (err: any) {
        setLoadError(err?.body?.error === 'storage_not_configured' ? 'storage' : 'generic');
      }
    })();
  }, [gymLoading, isSuperadmin]);

  async function download(build: MobileBuild) {
    setDownloadFailed(false);
    setDownloading(build.id);
    try {
      saveBlob(await pdfFetch(downloadPath(build)), build.file);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(null);
    }
  }

  if (gymLoading || !isSuperadmin) return null;

  const builds = data?.builds ?? [];
  const testflight = testflightHref(data?.testflight_url);

  return (
    <div>
      <h1 style={{ margin: '0 0 6px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 16px', color: '#666', maxWidth: 720 }}>{t('intro')}</p>

      {/* An iPhone cannot install a downloaded file: it gets its builds from TestFlight,
          so this is a link and never a download. Disabled until the app has one. */}
      <div style={{ ...cardSurfaceStyle, padding: 16, marginBottom: 16, maxWidth: 720 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('testflight_title')}</div>
        <p style={{ margin: '0 0 10px', color: '#444' }}>{t('testflight_text')}</p>
        {testflight ? (
          <a
            href={testflight}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...primaryBtnSmall(), display: 'inline-block', textDecoration: 'none' }}
          >
            {t('testflight_open')}
          </a>
        ) : (
          <>
            <button type="button" disabled style={{ ...primaryBtnSmall(), opacity: 0.5, cursor: 'not-allowed' }}>
              {t('testflight_open')}
            </button>
            <p style={{ margin: '8px 0 0', color: '#888', fontSize: 12.5 }}>{t('testflight_unavailable')}</p>
          </>
        )}
      </div>

      {showsAndroidInstallHelp(builds) && (
        <div style={{ ...cardSurfaceStyle, padding: 16, marginBottom: 16, maxWidth: 720 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('install_title')}</div>
          <ol style={{ margin: 0, paddingLeft: 20, color: '#444', lineHeight: 1.6 }}>
            <li>{t('install_android_1')}</li>
            <li>{t('install_android_2')}</li>
            <li>{t('install_android_3')}</li>
          </ol>
        </div>
      )}

      {loadError && (
        <p role="alert" style={{ color: '#b42318' }}>
          {t(loadError === 'storage' ? 'storage_not_configured' : 'load_failed')}
        </p>
      )}
      {downloadFailed && <p role="alert" style={{ color: '#b42318' }}>{t('download_failed')}</p>}

      {data && builds.length === 0 && !loadError && (
        <div>
          <p style={{ margin: '0 0 4px', color: '#444' }}>{t('empty')}</p>
          <p style={{ margin: 0, color: '#888' }}>{t('empty_hint')}</p>
        </div>
      )}

      {builds.length > 0 && (
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
          <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: MIN_WIDTH }}>
            <div className={LIST_GRID_ROW_CLASS} style={headerStyle}>
              {LIST_COLUMNS.map((col) => (
                <div key={col.key} className={CELL_CLASS[col.key]}>
                  {col.labelKey ? t(col.labelKey) : null}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {builds.map((build) => {
                const envKey = environmentLabelKey(build.environment);
                return (
                  <div key={build.id} style={{ ...cardSurfaceStyle }}>
                    <div className={LIST_GRID_ROW_CLASS} style={rowStyle}>
                      <div
                        className={CELL_CLASS.build}
                        title={`${build.app_name} ${formatBuildVersion(build)}`}
                        style={{ minWidth: 0 }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600 }}>{build.app_name}</span>
                          <span>{formatBuildVersion(build)}</span>
                          <span style={listNameBadgeStyle}>{envKey ? t(envKey) : build.environment}</span>
                        </div>
                        <div style={{ fontSize: 12.5, color: '#777', marginTop: 2 }}>
                          <code>{shortSha(build.git_sha)}</code>
                          {build.run_url && (
                            <>
                              {' · '}
                              <a href={build.run_url} target="_blank" rel="noopener noreferrer">{t('view_run')}</a>
                            </>
                          )}
                        </div>
                      </div>
                      <div className={CELL_CLASS.platform}>{t(platformLabelKey(build.platform))}</div>
                      <div className={CELL_CLASS.built}>{new Date(build.built_at).toLocaleString(locale)}</div>
                      <div className={CELL_CLASS.size}>{formatBytes(build.size_bytes)}</div>
                      <div className={CELL_CLASS.actions}>
                        <button
                          type="button"
                          style={primaryBtnSmall()}
                          disabled={downloading === build.id}
                          onClick={() => download(build)}
                          title={[
                            build.signer_sha1 ? t('signed_with', { sha1: build.signer_sha1 }) : null,
                            build.sha256 ? t('checksum', { sha256: build.sha256 }) : null,
                          ].filter(Boolean).join('\n') || undefined}
                        >
                          {downloading === build.id ? t('downloading') : t('download')}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <p style={{ color: '#888', fontSize: 12.5, marginTop: 12 }}>{t('keep_hint', { count: data?.keep ?? 20 })}</p>
          </div>
        </div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: GRID_COLUMNS, alignItems: 'center',
  gap: COLUMN_GAP, padding: `12px ${ROW_PADDING_X}px`,
};

const headerStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: GRID_COLUMNS, alignItems: 'center',
  padding: `6px ${ROW_PADDING_X}px`, gap: COLUMN_GAP, fontSize: 12, fontWeight: 600,
  color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4,
};
