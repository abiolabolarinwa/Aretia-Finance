/**
 * Logos for the three sign-in choices. When a wallet is installed it supplies its own logo (and that is used); these are stylised
 * stand-ins for when it is not, so the buttons always look the same. Static markup, never built from anything a person typed.
 */
const uri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const PHANTOM_LOGO = uri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="30" fill="#AB9FF2"/><path fill="#fff" d="M64 28C44 28 28 44 28 64v32c0 4 5 6 8 3l7-7c2-2 5-2 7 0l6 6c2 2 5 2 7 0l5-5c2-2 5-2 7 0l5 5c2 2 5 2 7 0l6-6c2-2 5-2 7 0l7 7c3 3 8 1 8-3V64c0-20-16-36-36-36z"/><circle cx="52" cy="62" r="6.5" fill="#3b2fa3"/><circle cx="80" cy="62" r="6.5" fill="#3b2fa3"/></svg>');

export const METAMASK_LOGO = uri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="30" fill="#fff"/><path fill="#E2761B" d="M18 22l38 28-7 16zM110 22L72 50l7 16z"/><path fill="#E4761B" d="M24 74l12 30 22-7zM104 74l-12 30-22-7z"/><path fill="#F6851B" d="M49 66l15 24 15-24-15-12z"/><path fill="#D7C1B3" d="M54 96l10 14 10-14-10 4z"/><path fill="#233447" d="M44 68h9v6h-9zM75 68h9v6h-9z"/></svg>');

/** A chain link, for "Connect others". */
export const OTHERS_LOGO = uri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="30" fill="#1a1a1a"/><g fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"><path d="M54 74l20-20"/><path d="M48 58l-10 10a16 16 0 0 0 22 22l10-10"/><path d="M80 70l10-10a16 16 0 0 0-22-22L58 48"/></g></svg>');
