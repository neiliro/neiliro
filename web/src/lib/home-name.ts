import { useEffect, useState } from 'react';
import { api } from './api';

const BRAND = 'Neiliro';

/**
 * Display name for the hub. Follows the calendarName / projectTitle
 * pattern: the default is product branding rendered in place; a name
 * set by the family is data and wins verbatim. (#136)
 */
export function homeName(settings: Record<string, string>): string {
  return settings['home.name']?.trim() || BRAND;
}

/**
 * Fetch the home name from the public endpoint — used by the login
 * page, which sits outside the auth gate and cannot read /api/settings.
 */
export function useHomeName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    void api
      .get<{ name: string }>('/home-name')
      .then((r) => setName(r.name))
      .catch(() => setName(BRAND));
  }, []);
  return name;
}
