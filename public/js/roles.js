'use strict';

// g: 'f' | 'm'. hs: hairstyle (women: long wavy bob pony bun; men: side quiff undercut wave). outfit: tie polo blazer blouse dress.
const ROLES = {
  'main': { label: 'AlifGunadi', color: '#e5e7eb', hair: '#3f2a1d', skin: '#ffe3cc', g: 'm', hs: 'side', outfit: 'blazer', glasses: true },
  'product-manager': { label: 'Product Manager', color: '#f59e0b', hair: '#111827', skin: '#e0ac69', g: 'f', hs: 'wavy', outfit: 'blouse' },
  'lead-business-analyst': { label: 'Business Analyst', color: '#14b8a6', hair: '#7c2d12', skin: '#ffdbac', g: 'm', hs: 'side', outfit: 'tie', glasses: true },
  'lead-solution-engineer': { label: 'Solution Eng', color: '#6366f1', hair: '#1f2937', skin: '#c68642', g: 'm', hs: 'quiff', outfit: 'polo', stubble: true },
  'lead-ux': { label: 'Lead UX', color: '#84cc16', hair: '#78350f', skin: '#f1c27d', g: 'f', hs: 'bun', outfit: 'blouse' },
  'lead-system-analyst': { label: 'System Analyst', color: '#f97316', hair: '#374151', skin: '#d9a066', g: 'm', hs: 'undercut', outfit: 'tie' },
  'lead-software-engineer': { label: 'Lead SWE', color: '#3b82f6', hair: '#0f172a', skin: '#f1c27d', g: 'f', hs: 'pony', outfit: 'blouse' },
  'lead-ui': { label: 'Lead UI', color: '#ec4899', hair: '#a16207', skin: '#ffdbac', g: 'f', hs: 'bob', outfit: 'dress' },
  'lead-qa': { label: 'Lead QA', color: '#22c55e', hair: '#451a03', skin: '#8d5524', g: 'm', hs: 'undercut', outfit: 'polo', pants: '#1f2937' },
  'lead-security': { label: 'Lead Security', color: '#ef4444', hair: '#111827', skin: '#e0ac69', g: 'f', hs: 'long', outfit: 'blazer' },
  'lead-dba': { label: 'Lead DBA', color: '#a855f7', hair: '#57534e', skin: '#c68642', g: 'm', hs: 'wave', outfit: 'blazer', glasses: true, pants: '#44403c' },
  'lead-devops': { label: 'Lead DevOps', color: '#0ea5e9', hair: '#292524', skin: '#f1c27d', g: 'm', hs: 'side', outfit: 'polo', stubble: true },
};
const PLAQUE_LABEL = { 'product-manager': 'Product Mgr', 'lead-business-analyst': 'Biz Analyst', 'lead-solution-engineer': 'Solution Eng', 'lead-system-analyst': 'Sys Analyst' };
const plaqueText = (id, label) => {
  if (hasOwn(PLAQUE_LABEL, id)) return PLAQUE_LABEL[id];
  const c = Array.from(label);
  return c.length > 14 ? c.slice(0, 13).join('') + '…' : label;
};
const GUEST = { color: '#9ca3af', hair: '#4b5563', skin: '#d6b38a' };
const STATUS_COLOR = { working: '#2f6fe0', waiting: '#f5b82e', done: '#1f9d55', idle: '#8b93a1' };

// Zones by role id (shared with the server, see roles-shared.js). Any id not listed here goes to the guest area.
const ZONE_IDS = OfficeRoles.ZONE_IDS;
const ZONE_OF = Object.create(null);
for (const [zone, ids] of Object.entries(ZONE_IDS)) for (const id of ids) ZONE_OF[id] = zone;

// Rooms: floor colour, accent colour (legend, minimap, stacked walls) and the outline of the floor plan. Doors are placed by buildLayout
// (layout.js): the wide floor plan puts them in the walls between rooms, the stacked layouts use a side gutter.
const ZONES = {
  trainer: { label: 'AlifGunadi Office', floor: '#f6e7c8', stroke: '#e2cfa3', wall: '#d9a441', glass: true },
  product: { label: 'Product', floor: '#dce8fb', stroke: '#b9ccee', wall: '#6b9bd6' },
  eng: { label: 'Engineering', floor: '#ddf1e4', stroke: '#b4dbc2', wall: '#6cb58a' },
  qa: { label: 'Quality & Security', floor: '#f7dde0', stroke: '#e5b8be', wall: '#e0848f', glass: true },
  lounge: { label: 'Lounge & Pantry', floor: '#efe6f7', stroke: '#d4c3e6', wall: '#9b8bd0' },
  guest: { label: 'Guests', floor: '#eceef2', stroke: '#cfd5df', wall: '#a3acba' },
};

