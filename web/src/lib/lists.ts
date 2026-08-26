import { t } from './i18n';

/**
 * The seeded list, like the Inbox project and the Shared calendar: its
 * name lives in the database in English and is translated back by id, so
 * a family that renames it keeps their own name.
 */
export const SHOPPING_LIST_ID = '00000000-0000-4000-8000-000000000301';

export function listTitle(id: string, title: string): string {
  // Guarded on the seeded value, the way calendarName already was and this
  // did not copy: without it a rename saves on the server and is then
  // overwritten on screen by the translation, which reads as "renaming
  // does nothing".
  return id === SHOPPING_LIST_ID && title === 'Shopping' ? t('Shopping') : title;
}

export interface ListItem {
  id: string;
  list_id: string;
  title: string;
  checked_at: string | null;
  position: number;
  /** Null is normal, not "unfiled": typing an item never requires a place */
  section_id?: string | null;
}

export interface ListSection {
  id: string;
  title: string;
  position: number;
}

export interface SharedList {
  id: string;
  title: string;
  position: number;
  open_items: number;
  checked_items: number;
  /** Present when a public link exists; the family may see its own link */
  share_token?: string | null;
}

export interface ListWithItems extends SharedList {
  items: ListItem[];
  sections: ListSection[];
}
