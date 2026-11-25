import type { ReactNode } from 'react'

/** Line icons drawn on a 24px grid. Form icons are listed in lib/icons.ts. */
const PATHS: Record<string, ReactNode> = {
  // form icons
  document: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></>,
  cart: <><path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H7" /><circle cx="9.5" cy="19" r="1.5" /><circle cx="17" cy="19" r="1.5" /></>,
  invoice: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  customer: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4.5 4-6.5 8-6.5s7 2 8 6.5" /></>,
  vendor: <><path d="M3 10l1.5-5h15L21 10M4 10v10h16V10" /><path d="M3 10a3 3 0 006 0 3 3 0 006 0 3 3 0 006 0M10 20v-5h4v5" /></>,
  product: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  warehouse: <><path d="M3 21V9l9-5 9 5v12" /><path d="M7 21v-8h10v8M7 17h10" /></>,
  truck: <><path d="M2 6h11v10H2zM13 9h4.5L21 12.5V16h-8" /><circle cx="6.5" cy="17.5" r="2" /><circle cx="17" cy="17.5" r="2" /></>,
  ledger: <><path d="M5 3h13a1 1 0 011 1v16a1 1 0 01-1 1H5z" /><path d="M5 3v18M9 8h6M9 12h6M9 16h3" /></>,
  project: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M7 9h6M7 13h10M7 17h4" /></>,
  service: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" /></>,
  // interface icons
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  minus: <path d="M6 12h12" />,
  up: <path d="M6 14l6-6 6 6" />,
  down: <path d="M6 10l6 6 6-6" />,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  back: <path d="M14 6l-6 6 6 6" />,
  alert: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5M12 17.5v.5" /></>,
  signout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  upload: <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 15v5h14v-5" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l2 2M14 9l2 2" /></>,
  next: <path d="M9 6l6 6-6 6" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
}

export default function Icon({ name, size = 18, className }: { name?: string; size?: number; className?: string }) {
  const path = (name && PATHS[name]) || PATHS.document
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  )
}
