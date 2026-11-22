import { describe, it, expect } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';
import {
  JOB_RUN_DEFAULT_COLUMNS, JOB_RUN_OPTIONAL_COLUMNS, JOB_RUNS_GRID, type JobRun,
  fetchAllJobRuns, jobRunColumnLabelKey, jobRunExportRow, jobRunsExportFileName, jobRunsGrid,
  optionalColumnValue, parseStoredJobRunColumns, toggleJobRunColumn, visibleJobRunColumns,
} from '../lib/jobRuns';
import { buildXlsx, columnLetter, xmlEscape } from '../lib/xlsxWorkbook';

function run(over: Partial<JobRun> = {}): JobRun {
  return {
    id: 'billing_run:1', job: 'billing_run', status: 'completed', started_at: '2026-11-20T02:00:00Z',
    finished_at: '2026-11-20T02:01:05Z', duration_seconds: 65, http_status: null, error_summary: null,
    details: { processed: 10, succeeded: 7, failed: 1, waived: 2, run_date: '2026-11-20' },
    result: 'warning', issues: ['failed_records'],
    metrics: { processed: 10, updated: 9, skipped: 1 },
    ...over,
  };
}

describe('Jobs optional columns (#3171)', () => {
  it('keeps the defaults and appends the selection in declaration order', () => {
    expect(visibleJobRunColumns([])).toEqual([...JOB_RUN_DEFAULT_COLUMNS]);
    expect(visibleJobRunColumns(['warnings', 'processed'])).toEqual([...JOB_RUN_DEFAULT_COLUMNS, 'processed', 'warnings']);
  });

  it('adds and hides a column without touching the others', () => {
    const one = toggleJobRunColumn([], 'failed');
    expect(one).toEqual(['failed']);
    expect(toggleJobRunColumn(toggleJobRunColumn(one, 'processed'), 'failed')).toEqual(['processed']);
  });

  it('reads back only known columns from storage', () => {
    expect(parseStoredJobRunColumns('["notified","bogus","processed"]')).toEqual(['processed', 'notified']);
    expect(parseStoredJobRunColumns('not json')).toEqual([]);
    expect(parseStoredJobRunColumns(null)).toEqual([]);
  });

  it('widens the grid only by the selected columns', () => {
    expect(jobRunsGrid([])).toBe(JOB_RUNS_GRID);
    expect(jobRunsGrid(['processed']).split(' ').length).toBe(JOB_RUNS_GRID.split(' ').length + 1);
  });

  it('takes values from the run and answers null where none was recorded', () => {
    const r = run();
    expect(optionalColumnValue(r, 'processed')).toBe(10);
    expect(optionalColumnValue(r, 'skipped')).toBe(1);
    expect(optionalColumnValue(r, 'waived')).toBe(2);
    expect(optionalColumnValue(r, 'run_date')).toBe('2026-11-20');
    expect(optionalColumnValue(r, 'notified')).toBeNull();
    expect(optionalColumnValue(r, 'http_status')).toBeNull();
    expect(optionalColumnValue(run({ http_status: 200 }), 'http_status')).toBe(200);
    expect(optionalColumnValue(run({ metrics: null, details: { skipped: 3 } }), 'skipped')).toBe(3);
  });

  it('has a heading for every column in every language', () => {
    for (const msgs of [en, es, ca]) {
      for (const c of [...JOB_RUN_DEFAULT_COLUMNS, ...JOB_RUN_OPTIONAL_COLUMNS]) {
        expect((msgs as any).job_runs[jobRunColumnLabelKey(c)], c).toBeTruthy();
      }
      for (const k of ['columns', 'columns_settings', 'columns_optional', 'export_excel', 'exporting', 'export_failed']) {
        expect((msgs as any).job_runs[k], k).toBeTruthy();
      }
    }
  });
});

describe('Jobs Excel export (#3171)', () => {
  const t = (k: string) => (en as any).job_runs[k] ?? k;

  it('writes exactly the visible columns, with an em dash where a value is missing', () => {
    const cols = visibleJobRunColumns(['notified', 'warnings']);
    const row = jobRunExportRow(run(), cols, { t, started: () => '20/11/2026 03:00' });
    expect(row).toHaveLength(cols.length);
    expect(row[0]).toBe(t('job_billing_run'));
    expect(row[2]).toBe(9);
    expect(row[4]).toBe('1m 05s');
    expect(row[5]).toBe(`${t('status_completed')} · ${t('result_warning')}`);
    expect(row[6]).toBe('—');
    expect(row[7]).toBe(t('issue_failed_records'));
  });

  it('reads every page matching the filters, not only the current one', async () => {
    const queries: string[] = [];
    const runs = Array.from({ length: 230 }, (_, i) => run({ id: `r${i}` }));
    const all = await fetchAllJobRuns({ job: 'billing_run', status: 'failed', from: '2026-11-01', to: '2026-11-22' }, async (q) => {
      queries.push(q);
      const p = new URLSearchParams(q);
      const offset = Number(p.get('offset'));
      return { items: runs.slice(offset, offset + Number(p.get('limit'))), total: runs.length, limit: 100, offset };
    });
    expect(all).toHaveLength(230);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toBe('job=billing_run&status=failed&from=2026-11-01&to=2026-11-22&limit=100&offset=0');
  });

  it('builds a workbook whose header row is the visible headings', () => {
    const bytes = buildXlsx('Jobs', ['Job', 'Failed'], [['Billing <run> & co', 3], ['x', null]]);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml', '_rels/.rels']));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Job</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>3</v></c>');
    expect(sheet).toContain('Billing &lt;run&gt; &amp; co');
    expect(sheet).toContain('<c r="B3"/>');
  });

  it('names columns and escapes text like Excel expects', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(xmlEscape('a\u0001"b')).toBe('a&quot;b');
  });

  it('names the file after the applied range', () => {
    expect(jobRunsExportFileName({ job: '', status: '', from: '2026-11-15', to: '2026-11-22' })).toBe('jobs-2026-11-15_2026-11-22.xlsx');
    expect(jobRunsExportFileName({ job: '', status: '', from: '', to: '' })).toBe('jobs.xlsx');
  });
});
