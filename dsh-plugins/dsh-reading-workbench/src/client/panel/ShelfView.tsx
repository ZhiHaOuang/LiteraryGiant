/**
 * 书架：封面网格 + 书脊感卡片。
 *
 * 封面来源两级：
 * 1. `/cover` 真实封面（epub/mobi 由 Host 从书里提取，`book.hasCover` 为 true 时才请求）；
 * 2. 无封面时渲染**生成式封面**——按书名哈希取两个色相做渐变，
 *    配书名与作者排版成书封（不引第三方库，纯 CSS）。
 *    色相只用主题 token 之外的 HSL 数值：这是「书籍封面色」，属于内容而非 UI 语义色，
 *    与明暗主题解耦（浅色下也不会与背景打架，因为封面自带投影与深色文字）。
 */
import { useMemo, useRef, useState } from 'react';
import type { BookFormat, BookWithState } from '../../shared/types.ts';
import type { WorkbenchApi } from '../api.ts';
import type { WorkbenchKey } from '../locales.ts';

/**
 * 网页书抓取的界面态（由 WorkbenchPage 轮询推进，本视图只负责展示与发指令）。
 *
 * 为什么状态放在上层而不是本组件：轮询必须**跨「书架 ⇄ 阅读器」两态存活**——
 * 用户抓书时可以点进另一本书看，抓到一半也不该停；放在 ShelfView 里会在切走时被卸载、轮询中断。
 */
export interface WebJob {
  /** 书目 id。 */
  bookId: string;
  /** 书名（进度卡标题）。 */
  title: string;
  /** 目录总章数（0 表示还没读到）。 */
  total: number;
  /** 已抓章数。 */
  fetched: number;
  /** 失败章节条数。 */
  errorCount: number;
  /** 最近一次进度错误（网络/路由问题；章节级失败只计数不填这里）。 */
  error?: string;
  /** 是否正在自动续抓（用户点「继续」或刚建完书时为 true）。 */
  active: boolean;
  /** 是否已抓完（pending === 0）。 */
  done: boolean;
  /** 是否已经开抓过（决定按钮文案「继续」还是「抓取剩余章节」）。 */
  started: boolean;
}

/** 组件依赖。 */
export interface ShelfViewProps {
  api: WorkbenchApi;
  t: (key: WorkbenchKey) => string;
  books: BookWithState[];
  busy: boolean;
  dragging: boolean;
  onDragStateChange(dragging: boolean): void;
  onImport(files: FileList | File[]): void;
  onOpen(bookId: string): void;
  onRemove(bookId: string): void;
  /** 网页书抓取任务（由上层排好序：进行中在前，其次按书名）。 */
  webJobs: WebJob[];
  /** 提交网页书源 URL。 */
  onAddWebSource(url: string): Promise<boolean>;
  /** 继续自动续抓。 */
  onResumeWebJob(bookId: string): void;
  /** 暂停自动续抓（进度保留，可再继续）。 */
  onStopWebJob(bookId: string): void;
  /** 关闭进度卡（不删书，只是不再显示）。 */
  onDismissWebJob(bookId: string): void;
}

/** 排序方式。 */
type SortKey = 'recent' | 'title' | 'author';

/** 书名 → 稳定色相（0-359）。 */
export function hueOf(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) % 100000;
  }
  return hash % 360;
}

/** 格式徽标文案。 */
function formatLabel(format: BookFormat): string {
  return format.toUpperCase();
}

/** 生成式封面（按书名取色的渐变卡）。 */
function GeneratedCover({ title, author }: { title: string; author?: string }) {
  const hue = hueOf(title);
  // 同色系两端：色相偏 ±24 度，深浅拉开，形成书封的纵向渐变
  const from = `hsl(${hue} 42% 62%)`;
  const to = `hsl(${(hue + 24) % 360} 46% 42%)`;
  return (
    <div className="dsh-reading-gencover" style={{ backgroundImage: `linear-gradient(150deg, ${from}, ${to})` }}>
      <span className="dsh-reading-gencover-title">{title}</span>
      {author !== undefined && author !== '' && <span className="dsh-reading-gencover-author">{author}</span>}
    </div>
  );
}

/** 封面图（onError 时回落到生成式封面）。 */
function BookCover({ api, entry }: { api: WorkbenchApi; entry: BookWithState }) {
  const [failed, setFailed] = useState(false);
  const showReal = entry.book.hasCover === true && !failed;
  if (!showReal) return <GeneratedCover title={entry.book.title} author={entry.book.author} />;
  return (
    <img
      className="dsh-reading-coverimg"
      src={api.coverUrl(entry.book.id)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 书架视图。 */
export function ShelfView({
  api,
  t,
  books,
  busy,
  dragging,
  onDragStateChange,
  onImport,
  onOpen,
  onRemove,
  webJobs = [],
  onAddWebSource,
  onResumeWebJob,
  onStopWebJob,
  onDismissWebJob,
}: ShelfViewProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [webFormOpen, setWebFormOpen] = useState(false);
  const [webUrl, setWebUrl] = useState('');
  const [webInvalid, setWebInvalid] = useState(false);
  const [webSubmitting, setWebSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = keyword === ''
      ? books
      : books.filter(
          (entry) =>
            entry.book.title.toLowerCase().includes(keyword) ||
            (entry.book.author ?? '').toLowerCase().includes(keyword),
        );
    const sorted = [...filtered];
    if (sort === 'title') {
      sorted.sort((a, b) => a.book.title.localeCompare(b.book.title, 'zh-Hans-CN'));
    } else if (sort === 'author') {
      sorted.sort((a, b) => (a.book.author ?? '').localeCompare(b.book.author ?? '', 'zh-Hans-CN'));
    } else {
      sorted.sort((a, b) => b.book.addedAt - a.book.addedAt);
    }
    return sorted;
  }, [books, query, sort]);

  /** 提交网页书源：只做 URL 形状校验（协议白名单），站点能否解析交给 Host 报错。 */
  const submitWebSource = (): void => {
    const url = webUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      setWebInvalid(true);
      return;
    }
    setWebInvalid(false);
    setWebSubmitting(true);
    void onAddWebSource(url).then((created) => {
      setWebSubmitting(false);
      if (created) {
        // 建书成功才清空输入并收起输入条；失败时保留 URL 方便用户改
        setWebUrl('');
        setWebFormOpen(false);
      }
    });
  };

  /** 进度百分比（总数未知时按 0 处理，进度条留在起点）。 */
  const percentOf = (job: WebJob): number => {
    if (job.total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((job.fetched / job.total) * 100)));
  };

  return (
    <section
      className={dragging ? 'dsh-reading-shelf dsh-reading-dragging' : 'dsh-reading-shelf'}
      aria-label={t('shelf.title')}
      onDragOver={(event) => {
        event.preventDefault();
        onDragStateChange(true);
      }}
      onDragLeave={() => onDragStateChange(false)}
      onDrop={(event) => {
        event.preventDefault();
        onDragStateChange(false);
        onImport(event.dataTransfer.files);
      }}
    >
      <header className="dsh-reading-shelfbar">
        <div className="dsh-reading-shelfbar-left">
          <h2 className="dsh-reading-shelfbar-title">{t('shelf.title')}</h2>
          <span className="dsh-reading-shelfbar-count">
            {books.length} {t('shelf.count')}
          </span>
        </div>
        <div className="dsh-reading-shelfbar-right">
          <input
            className="dsh-reading-search"
            type="search"
            value={query}
            placeholder={t('shelf.search')}
            aria-label={t('shelf.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="dsh-reading-sort"
            value={sort}
            aria-label={t('shelf.sort.recent')}
            onChange={(event) => setSort(event.target.value as SortKey)}
          >
            <option value="recent">{t('shelf.sort.recent')}</option>
            <option value="title">{t('shelf.sort.title')}</option>
            <option value="author">{t('shelf.sort.author')}</option>
          </select>
          <button
            type="button"
            className="dsh-reading-secondary"
            title={t('web.form.hint')}
            aria-expanded={webFormOpen}
            onClick={() => {
              setWebFormOpen((open) => !open);
              setWebInvalid(false);
            }}
          >
            {t('web.title')}
          </button>
          <button
            type="button"
            className="dsh-reading-primary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? t('import.working') : t('shelf.import')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt,.html,.htm,.epub,.mobi,.pdf"
            multiple
            hidden
            onChange={(event) => {
              const picked = event.target.files;
              if (picked !== null && picked.length > 0) onImport(picked);
              event.target.value = '';
            }}
          />
        </div>
      </header>

      {webFormOpen && (
        <div className="dsh-reading-webform">
          <label className="dsh-reading-webform-label" htmlFor="dsh-reading-web-url">
            {t('web.title')}
          </label>
          <input
            id="dsh-reading-web-url"
            className="dsh-reading-webform-input"
            type="url"
            value={webUrl}
            autoFocus
            spellCheck={false}
            aria-invalid={webInvalid}
            placeholder={t('web.form.placeholder')}
            onChange={(event) => {
              setWebUrl(event.target.value);
              setWebInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitWebSource();
              } else if (event.key === 'Escape') {
                setWebFormOpen(false);
                setWebInvalid(false);
              }
            }}
          />
          <button
            type="button"
            className="dsh-reading-primary"
            disabled={webSubmitting || webUrl.trim() === ''}
            onClick={submitWebSource}
          >
            {webSubmitting ? t('web.submitting') : t('web.submit')}
          </button>
          <button type="button" className="dsh-reading-secondary" onClick={() => setWebFormOpen(false)}>
            {t('web.cancel')}
          </button>
          <p className={webInvalid ? 'dsh-reading-error dsh-reading-webform-hint' : 'dsh-reading-hint dsh-reading-webform-hint'}>
            {webInvalid ? t('web.invalid') : t('web.form.hint')}
          </p>
        </div>
      )}

      {webJobs.length > 0 && (
        <ul className="dsh-reading-webjobs">
          {webJobs.map((job) => {
            const finished = job.done;
            const status = job.error !== undefined
              ? job.error
              : finished
                ? t('web.progress.done')
                : job.active
                  ? t('web.progress.fetching')
                  : t('web.progress.stopped');
            const state = job.error !== undefined ? 'error' : finished ? 'done' : 'running';
            return (
              <li key={job.bookId} className="dsh-reading-webjob">
                <div className="dsh-reading-webjob-head">
                  <span className="dsh-reading-webjob-title" title={job.title}>
                    {job.title}
                  </span>
                  <span className="dsh-reading-webjob-status" data-state={state}>
                    {t('web.progress')
                      .replace('{fetched}', String(job.fetched))
                      .replace('{total}', String(Math.max(job.total, job.fetched)))}
                    {' · '}
                    {status}
                  </span>
                  <span className="dsh-reading-webjob-actions">
                    {job.errorCount > 0 && (
                      <span className="dsh-reading-webjob-status" data-state="error">
                        {t('web.progress.errors').replace('{count}', String(job.errorCount))}
                      </span>
                    )}
                    {!finished && !job.active && (
                      <button
                        type="button"
                        className="dsh-reading-secondary"
                        onClick={() => onResumeWebJob(job.bookId)}
                      >
                        {job.started ? t('web.resume') : t('web.start')}
                      </button>
                    )}
                    {!finished && (
                      <button
                        type="button"
                        className="dsh-reading-secondary"
                        aria-label={t('web.close')}
                        title={t('web.close')}
                        onClick={() => onDismissWebJob(job.bookId)}
                      >
                        ×
                      </button>
                    )}
                    {job.active && (
                      <button
                        type="button"
                        className="dsh-reading-secondary"
                        onClick={() => onStopWebJob(job.bookId)}
                      >
                        {t('web.stop')}
                      </button>
                    )}
                    {finished && (
                      <button
                        type="button"
                        className="dsh-reading-secondary"
                        aria-label={t('web.close')}
                        title={t('web.close')}
                        onClick={() => onDismissWebJob(job.bookId)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                </div>
                <span className="dsh-reading-webjob-bar" aria-hidden="true">
                  <span className="dsh-reading-webjob-bar-fill" style={{ width: `${percentOf(job)}%` }} />
                </span>
                {/* 只抓了一部分且当前不在抓：说明「可以先读、也可以稍后接着抓」，
                    否则暂停态在用户眼里就像卡死了 */}
                {!finished && !job.active && job.fetched > 0 && (
                  <p className="dsh-reading-hint">{t('web.hint.partial')}</p>
                )}
                {/* 没抓完时说明「未下载的章节点开时会自动抓取」：用户不必等整本抓完，
                    也不该以为「没抓的章读不了」（Lead 授权的单行改动） */}
                {!finished && <p className="dsh-reading-hint">{t('web.hint.autofetch')}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {books.length === 0 ? (
        <div className="dsh-reading-empty">
          <p className="dsh-reading-empty-title">{t('shelf.empty')}</p>
          <p className="dsh-reading-hint">{dragging ? t('shelf.drop') : t('shelf.empty.hint')}</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="dsh-reading-hint">{t('shelf.noresult')}</p>
      ) : (
        <ul className="dsh-reading-grid">
          {visible.map((entry) => {
            const percent = entry.progress === undefined ? 0 : Math.round(entry.progress.percent);
            return (
              <li key={entry.book.id} className="dsh-reading-card">
                <button
                  type="button"
                  className="dsh-reading-cardcover"
                  title={t('shelf.open')}
                  onClick={() => onOpen(entry.book.id)}
                >
                  <BookCover api={api} entry={entry} />
                  {/* 来源标识：网页书源抓来的书在格式徽标下方再挂一枚（「网页」比 WEB 更直白） */}
                  {entry.book.source === 'web' && (
                    <span className="dsh-reading-badge dsh-reading-badge-web">{t('web.badge')}</span>
                  )}
                  <span className="dsh-reading-badge">{formatLabel(entry.book.format)}</span>
                  {percent > 0 && (
                    <span className="dsh-reading-cardprogress" aria-hidden="true">
                      <span className="dsh-reading-cardprogress-fill" style={{ width: `${percent}%` }} />
                    </span>
                  )}
                </button>
                <div className="dsh-reading-cardmeta">
                  <button
                    type="button"
                    className="dsh-reading-cardtitle"
                    title={entry.book.title}
                    onClick={() => onOpen(entry.book.id)}
                  >
                    {entry.book.title}
                  </button>
                  <span className="dsh-reading-cardauthor">
                    {entry.book.author ?? '—'}
                    {entry.highlightCount > 0 ? ` · ${entry.highlightCount}` : ''}
                    {percent > 0 ? ` · ${percent}%` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="dsh-reading-cardremove"
                  title={t('shelf.remove')}
                  aria-label={t('shelf.remove')}
                  onClick={() => {
                    if (window.confirm(t('shelf.remove.confirm'))) onRemove(entry.book.id);
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
