import { t } from './i18n';

/**
 * The seeded list, like the Inbox project and the Shared calendar: its
 * name lives in the database in English and is translated back by id, so
 * a family that renames it keeps their own name.
 */
export const SHOPPING_LIST_ID = '00000000-0000-4000-8000-000000000301';

export function listTitle(id: string, title: string): string {
  return id === SHOPPING_LIST_ID ? t('Shopping') : title;
}

export interface ListItem {
  id: string;
  list_id: string;
  title: string;
  checked_at: string | null;
  position: number;
}

export interface SharedList {
  id: string;
  title: string;
  position: number;
  open_items: number;
  checked_items: number;
}

export interface ListWithItems extends SharedList {
  items: ListItem[];
}
