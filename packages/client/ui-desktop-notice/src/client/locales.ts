/** `desktop-notice` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'turn.title': '「{title}」已完成',
  'turn.body': '任务在后台完成，点击回到该会话。',
} satisfies Record<string, string>

/** The desktop-notice namespace key union. */
export type DesktopNoticeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'turn.title': '“{title}” finished',
  'turn.body': 'It finished in the background. Click to open the session.',
} satisfies Record<DesktopNoticeKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'turn.title': '「{title}」が完了しました',
  'turn.body': 'バックグラウンドで完了しました。クリックするとそのセッションに戻ります。',
} satisfies Record<DesktopNoticeKey, string>

/** Spanish copy, checked against the English keys. */
export const es = {
  'turn.title': '«{title}» ha terminado',
  'turn.body': 'Terminó en segundo plano. Haga clic para abrir la sesión.',
} satisfies Record<DesktopNoticeKey, string>

/** French copy, checked against the English keys. */
export const fr = {
  'turn.title': '« {title} » est terminé',
  'turn.body': 'Terminé en arrière-plan. Cliquez pour ouvrir la session.',
} satisfies Record<DesktopNoticeKey, string>

/** German copy, checked against the English keys. */
export const de = {
  'turn.title': '„{title}“ ist abgeschlossen',
  'turn.body': 'Im Hintergrund abgeschlossen. Klicken, um die Sitzung zu öffnen.',
} satisfies Record<DesktopNoticeKey, string>

/** Russian copy, checked against the English keys. */
export const ru = {
  'turn.title': '«{title}» завершён',
  'turn.body': 'Завершено в фоновом режиме. Нажмите, чтобы открыть сеанс.',
} satisfies Record<DesktopNoticeKey, string>

/** Portuguese copy, checked against the English keys. */
export const pt = {
  'turn.title': '“{title}” foi concluído',
  'turn.body': 'Concluído em segundo plano. Clique para abrir a sessão.',
} satisfies Record<DesktopNoticeKey, string>
