/**
 * Boot-page language, resolved before any client plugin can load.
 *
 * The shell markup declares one language, but a screen reader reads the frame
 * that is on screen: the boot page states the language the reader is most
 * likely using and shows its own copy in it. The locale plugin corrects both
 * once it activates, including a stored preference this cannot know.
 * @module @deepseek-ai/dsh-client-web/src/boot-locale
 */

/** Every language this build ships dictionaries for. */
export type BootLocale = 'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt'

/** Shipped languages in resolution order after the requested one. */
const SHIPPED: readonly BootLocale[] = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

/** Boot-page copy per language; framework-free so it survives a failed client tree. */
export interface BootCopy {
  /** Visible hint under the wordmark while entries activate. */
  readonly loading: string
  /** Heading of the failure report. */
  readonly failedTitle: string
  /** Retry button label. */
  readonly retry: string
  /** Summary of the collapsible technical report. */
  readonly diagnostics: string
}

const COPY: Record<BootLocale, BootCopy> = {
  en: { loading: 'Loading plugins…', failedTitle: 'Plugins failed to load', retry: 'Try again', diagnostics: 'Details' },
  zh: { loading: '正在加载插件…', failedTitle: '插件加载失败', retry: '重试', diagnostics: '诊断信息' },
  ja: { loading: 'プラグインを読み込み中…', failedTitle: 'プラグインを読み込めませんでした', retry: '再試行', diagnostics: '詳細' },
  es: { loading: 'Cargando complementos…', failedTitle: 'No se pudieron cargar los complementos', retry: 'Reintentar', diagnostics: 'Detalles' },
  fr: { loading: 'Chargement des modules…', failedTitle: 'Échec du chargement des modules', retry: 'Réessayer', diagnostics: 'Détails' },
  de: { loading: 'Plugins werden geladen…', failedTitle: 'Plugins konnten nicht geladen werden', retry: 'Erneut versuchen', diagnostics: 'Details' },
  ru: { loading: 'Загрузка плагинов…', failedTitle: 'Не удалось загрузить плагины', retry: 'Повторить', diagnostics: 'Подробности' },
  pt: { loading: 'Carregando plugins…', failedTitle: 'Falha ao carregar os plugins', retry: 'Tentar novamente', diagnostics: 'Detalhes' },
}

/**
 * Pick the shipped language a browser or shell prefers.
 * @param languages - `navigator.languages` (or the shell's ordered tags), most preferred first.
 * @returns the first shipped language whose primary subtag matches, else `en`.
 */
export function resolveBootLocale(languages: readonly string[]): BootLocale {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0]
    const match = SHIPPED.find(locale => locale === primary)
    if (match !== undefined) return match
  }
  return 'en'
}

/**
 * Copy for one boot language.
 * @param locale - language resolved for this page load.
 * @returns the five strings the boot page draws.
 */
export function bootCopy(locale: BootLocale): BootCopy {
  return COPY[locale]
}

/**
 * Declare the resolved language on the document before the boot page draws.
 *
 * `zh` is stated as `zh-CN` for the same reason the locale plugin does it:
 * screen readers pick a Chinese voice from the regional tag.
 * @param document - the document the boot page draws into.
 * @param languages - ordered language tags; omitted reads `navigator.languages`.
 * @returns the language that was applied.
 */
export function applyBootLocale(
  document: Document,
  languages?: readonly string[],
): BootLocale {
  const preferred = languages ?? navigator.languages ?? [navigator.language]
  const locale = resolveBootLocale(preferred)
  const tag = locale === 'zh' ? 'zh-CN' : locale
  if (document.documentElement.lang !== tag) document.documentElement.lang = tag
  return locale
}
