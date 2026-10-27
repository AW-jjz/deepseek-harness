/**
 * The delete action: one `sidebar.workspaces.session.menu.item` row over an
 * injected behavior. Removal is recoverable — the store parks the Session in its
 * recycle bin and the success notice offers undo — so the row asks for no
 * confirmation. A Session with a running Turn is not offered the action: the
 * Host refuses to remove a log that Turn is appending to. An idle-but-loaded
 * Agent still refuses at the Host, and the notice names the reason.
 */
import type { SessionMenuItemProps } from '../contract/slots.ts'
import type { DeleteSessionInjected } from '../contract/slots.ts'
import { IconTrashOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Menu row (order 480): remove one stored Session. Absent for a Session with a
 * running Turn, an archived row (which keeps the history it was archived from),
 * and one the caller may not remove.
 * @param props - owner share, the delete share, the access Hook, and the menu open state.
 * @returns the row, or nothing when removal does not apply to this Session.
 */
export function DeleteSessionMenuItem({
  sessionId, useLive, useArchived, useMenuOpenState, useSessionAccess, deleteSession, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const live = useLive(set => set.has(sessionId))
  const archived = useArchived(set => set.has(sessionId))
  const allowed = useSessionAccess(sessionId, 'workspace/archiveSession')
  if (live || archived || !allowed) return null
  return (
    <MenuItemButton
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        deleteSession(sessionId)
      }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}
