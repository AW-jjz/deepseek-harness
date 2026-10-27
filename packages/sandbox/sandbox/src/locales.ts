/**
 * Locale-owned sandbox approval text; audit inputs remain verbatim.
 *
 * A person deciding on an escalation is not reading a config file: the
 * sentence names the permission in their language and what it lets the call
 * do, instead of pasting the internal id (`danger-full-access`) into prose.
 * The raw id still travels in the audit `reason` and in the tool call's own
 * argument, so the technical record keeps it.
 */

/** Shipped escalation target modes, keyed the way the audit record spells them. */
const MODE_LABELS = {
  'read-only': {
    en: 'read-only', zh: '只读', ja: '読み取り専用', es: 'solo lectura',
    fr: 'lecture seule', de: 'nur lesend', ru: 'только чтение', pt: 'somente leitura',
  },
  'workspace-write': {
    en: 'workspace-write', zh: '工作区写入', ja: 'ワークスペース書き込み', es: 'escritura en el espacio de trabajo',
    fr: "écriture dans l'espace de travail", de: 'Schreiben im Arbeitsbereich', ru: 'запись в рабочей области',
    pt: 'gravação na área de trabalho',
  },
  'danger-full-access': {
    en: 'full access', zh: '完全访问', ja: 'フルアクセス', es: 'acceso total',
    fr: 'accès complet', de: 'Vollzugriff', ru: 'полный доступ', pt: 'acesso total',
  },
} as const

/** What one escalated mode actually lets the call do, said in the operator's language. */
const MODE_CONSEQUENCES = {
  'read-only': {
    en: 'it can read files anywhere, but not change them',
    zh: '它可以读取计算机上的任何文件，但不能修改',
    ja: 'コンピューター上の任意のファイルを読み取れますが、変更はできません',
    es: 'puede leer cualquier archivo del equipo, pero no modificarlo',
    fr: "il peut lire n'importe quel fichier de l'ordinateur, mais pas le modifier",
    de: 'es kann jede Datei auf dem Computer lesen, aber nicht verändern',
    ru: 'он может читать любые файлы на компьютере, но не изменять их',
    pt: 'ele pode ler qualquer arquivo do computador, mas não alterá-lo',
  },
  'workspace-write': {
    en: 'it can write inside this workspace only',
    zh: '它只能在工作区目录内写入',
    ja: 'このワークスペースの中だけに書き込めます',
    es: 'solo puede escribir dentro de este espacio de trabajo',
    fr: 'il ne peut écrire que dans cet espace de travail',
    de: 'es kann nur innerhalb dieses Arbeitsbereichs schreiben',
    ru: 'он может записывать только внутри этой рабочей области',
    pt: 'ele pode gravar apenas dentro desta área de trabalho',
  },
  'danger-full-access': {
    en: 'it can read and change any file on this computer, outside the workspace sandbox',
    zh: '它可以读写这台计算机上的任何文件，不受工作区沙箱限制',
    ja: 'ワークスペースのサンドボックスを越えて、このコンピューター上の任意のファイルを読み書きできます',
    es: 'puede leer y modificar cualquier archivo del equipo, fuera del aislamiento del espacio de trabajo',
    fr: "il peut lire et modifier n'importe quel fichier de l'ordinateur, hors du bac à sable de l'espace de travail",
    de: 'es kann jede Datei auf diesem Computer lesen und ändern, außerhalb der Arbeitsbereichs-Sandbox',
    ru: 'он может читать и изменять любые файлы на этом компьютере, вне песочницы рабочей области',
    pt: 'ele pode ler e alterar qualquer arquivo deste computador, fora da caixa de proteção da área de trabalho',
  },
} as const

/** One shipped locale id, matching the Client's text resolver. */
type Locale = 'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt'

/** Permission and consequence phrase for one target mode; an unknown future mode stays verbatim. */
function describe(mode: string, locale: Locale): { label: string; consequence?: string } {
  if (!(mode in MODE_LABELS)) return { label: mode }
  const target = mode as keyof typeof MODE_LABELS
  return { label: MODE_LABELS[target][locale], consequence: MODE_CONSEQUENCES[target][locale] }
}

/** One escalation sentence: permission, consequence, then the model's own justification, verbatim. */
const templates: Record<Locale, (label: string, consequence: string | undefined, justification: string) => string> = {
  en: (label, consequence, justification) => `Allow this operation with ${label} permissions${consequence === undefined ? '' : ` — ${consequence}`}: ${justification}`,
  zh: (label, consequence, justification) => `允许本次操作使用「${label}」权限${consequence === undefined ? '' : `——${consequence}`}：${justification}`,
  ja: (label, consequence, justification) => `この操作を「${label}」権限で許可します${consequence === undefined ? '' : `（${consequence}）`}：${justification}`,
  es: (label, consequence, justification) => `Permitir esta operación con permisos de ${label}${consequence === undefined ? '' : `: ${consequence}`}: ${justification}`,
  fr: (label, consequence, justification) => `Autoriser cette opération avec les permissions « ${label} »${consequence === undefined ? '' : ` : ${consequence}`} : ${justification}`,
  de: (label, consequence, justification) => `Diesen Vorgang mit „${label}“-Berechtigungen zulassen${consequence === undefined ? '' : ` (${consequence})`}: ${justification}`,
  ru: (label, consequence, justification) => `Разрешить эту операцию с правами «${label}»${consequence === undefined ? '' : ` (${consequence})`}: ${justification}`,
  pt: (label, consequence, justification) => `Permitir esta operação com permissões de ${label}${consequence === undefined ? '' : ` — ${consequence}`}: ${justification}`,
}

/**
 * Build translations for the existing Client localized-text resolver.
 * @param mode - requested sandbox mode; an unrecognized value is shown verbatim.
 * @param justification - raw model justification, preserved in every translation.
 * @returns localized approval text, one entry per shipped locale.
 */
export function escalationDisplayReason(mode: string, justification: string): Record<Locale, string> {
  const build = (locale: Locale): string => {
    const { label, consequence } = describe(mode, locale)
    return templates[locale](label, consequence, justification)
  }
  return {
    en: build('en'),
    zh: build('zh'),
    ja: build('ja'),
    es: build('es'),
    fr: build('fr'),
    de: build('de'),
    ru: build('ru'),
    pt: build('pt'),
  }
}
